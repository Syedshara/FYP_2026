

import gc
import hashlib
import os
import secrets
from functools import reduce

import numpy as np
import tenseal as ts
import torch

from fl_common.he_utils import create_ckks_context


# ── XOR helpers ────────────────────────────────────────────────────────────────

def _xor_bytes(a: bytes, b: bytes) -> bytes:
    """Return a XOR b (both must have the same length)."""
    return bytes(x ^ y for x, y in zip(a, b))


def _xor_all(byte_strings: list[bytes]) -> bytes:
    """XOR-fold a non-empty list of equal-length byte strings."""
    return reduce(_xor_bytes, byte_strings)


# ── Commitment helpers ──────────────────────────────────────────────────────────

def _make_commitment(share: bytes, nonce: bytes) -> bytes:
    """Return SHA-256(share || nonce) as 32 raw bytes."""
    return hashlib.sha256(share + nonce).digest()


# ── Public API ─────────────────────────────────────────────────────────────────

def split_key(
    ctx: ts.Context,
    client_names: list[str],
) -> dict:
    
    if not client_names:
        raise ValueError("client_names must contain at least one entry")

    # ── 1. Serialise the secret key while it is still present ────────────────
    key_bytes: bytes = ctx.serialize(save_secret_key=True)
    n: int = len(key_bytes)

    # ── 2. Generate N-1 random shares; last share closes the XOR identity ────
    random_shares: list[bytes] = [secrets.token_bytes(n) for _ in range(len(client_names) - 1)]
    last_share: bytes = _xor_all(random_shares + [key_bytes]) if random_shares else key_bytes
    all_shares: list[bytes] = random_shares + [last_share]

    # ── 3. Build per-client nonces and commitments ────────────────────────────
    shares: dict[str, bytes] = {}
    nonces: dict[str, bytes] = {}
    commitments: dict[str, bytes] = {}

    for name, share in zip(client_names, all_shares):
        nonce = os.urandom(32)
        shares[name] = share
        nonces[name] = nonce
        commitments[name] = _make_commitment(share, nonce)

    # ── 4. Strip the secret key from the live context ─────────────────────────
    ctx.make_context_public()

    return {
        "shares": shares,
        "nonces": nonces,
        "commitments": commitments,
    }


def verify_share(
    share: bytes,
    nonce: bytes,
    commitment: bytes,
) -> bool:
   
    return _make_commitment(share, nonce) == commitment


def reconstruct_and_get_context(
    contributed_shares: dict[str, bytes],
    nonces: dict[str, bytes],
    commitments: dict[str, bytes],
    public_ctx: ts.Context,
) -> ts.Context:
   
    # ── 1. Verify every share before touching key material ────────────────────
    for name in contributed_shares:
        share = contributed_shares[name]
        nonce = nonces[name]
        commitment = commitments[name]
        if not verify_share(share, nonce, commitment):
            raise ValueError(f"Client {name} sent an invalid share")

    # ── 2. XOR all shares to recover key bytes ────────────────────────────────
    ordered_shares: list[bytes] = list(contributed_shares.values())
    key_bytes: bytes = _xor_all(ordered_shares)

    # ── 3. Deserialise into a private context ─────────────────────────────────
    reconstructed_ctx: ts.Context = ts.context_from(key_bytes)
    return reconstructed_ctx


def threshold_decrypt(
    enc_vectors: dict[str, ts.CKKSVector],
    contributed_shares: dict[str, bytes],
    nonces: dict[str, bytes],
    commitments: dict[str, bytes],
    shapes: dict[str, tuple],
    public_ctx: ts.Context,
    num_clients: int,
) -> dict[str, torch.Tensor]:
   
    # ── Reconstruct private context (raises on bad shares) ───────────────────
    private_ctx = reconstruct_and_get_context(
        contributed_shares, nonces, commitments, public_ctx
    )

    decrypted: dict[str, torch.Tensor] = {}
    try:
        for layer_name, enc_vec in enc_vectors.items():
            # Link ciphertext to the private context so decrypt() works
            enc_vec.link_context(private_ctx)
            flat = np.array(enc_vec.decrypt(), dtype=np.float32)
            flat = np.nan_to_num(flat, nan=0.0, posinf=0.0, neginf=0.0)

            shape = shapes[layer_name]
            num_elements = int(np.prod(shape))
            flat = flat[:num_elements]

            tensor = torch.tensor(flat, dtype=torch.float32).reshape(shape)
            tensor = tensor / num_clients
            decrypted[layer_name] = tensor
    finally:
        # ── Destroy private context regardless of success / failure ──────────
        del private_ctx
        gc.collect()

    return decrypted


def proactive_refresh(
    public_ctx: ts.Context,
    contributed_shares: dict[str, bytes],
    nonces: dict[str, bytes],
    commitments: dict[str, bytes],
    client_names: list[str],
) -> dict:
   
    # ── 1. Reconstruct private context ───────────────────────────────────────
    private_ctx = reconstruct_and_get_context(
        contributed_shares, nonces, commitments, public_ctx
    )

    # ── 2. Re-split into fresh shares; this also strips the key from ctx ──────
    try:
        new_vss = split_key(private_ctx, client_names)
    finally:
        # ── 3. Destroy reconstructed context ─────────────────────────────────
        del private_ctx
        gc.collect()

    return new_vss


# ── Self-test ──────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("Running VSS self-tests …")

    # ── Test 1: create context ────────────────────────────────────────────────
    ctx = create_ckks_context()
    print("  [1] CKKS context created.")

    # ── Test 2: split for 3 clients ───────────────────────────────────────────
    client_names = ["Bank_A", "Bank_B", "Bank_C"]
    vss = split_key(ctx, client_names)
    shares = vss["shares"]
    nonces = vss["nonces"]
    commitments = vss["commitments"]
    print(f"  [2] Key split into {len(client_names)} shares.")

    # ── Test 3: all commitments verify ────────────────────────────────────────
    for name in client_names:
        result = verify_share(shares[name], nonces[name], commitments[name])
        assert result, f"verify_share() returned False for {name}"
    print("  [3] All commitments verified — OK.")

    # ── Test 4: tampered share is rejected ────────────────────────────────────
    original_share_c = shares["Bank_C"]
    tampered = bytes([original_share_c[0] ^ 0xFF]) + original_share_c[1:]
    shares["Bank_C"] = tampered

    raised = False
    try:
        reconstruct_and_get_context(shares, nonces, commitments, ctx)
    except ValueError as exc:
        raised = True
        assert "Bank_C" in str(exc), f"Expected 'Bank_C' in error message, got: {exc}"
    assert raised, "reconstruct_and_get_context() should have raised ValueError"
    print("  [4] Tampered share correctly rejected with ValueError mentioning 'Bank_C'.")

    # ── Test 5: correct shares reconstruct without error ─────────────────────
    shares["Bank_C"] = original_share_c  # restore
    recovered_ctx = reconstruct_and_get_context(shares, nonces, commitments, ctx)
    assert recovered_ctx is not None
    del recovered_ctx
    gc.collect()
    print("  [5] Correct shares reconstructed context successfully.")

    # ── Test 6: proactive refresh produces different shares ───────────────────
    new_vss = proactive_refresh(ctx, shares, nonces, commitments, client_names)
    new_shares = new_vss["shares"]
    for name in client_names:
        assert new_shares[name] != shares[name], (
            f"New share for {name} is identical to old share — refresh failed"
        )
    print("  [6] Proactive refresh produced distinct new shares.")

    print("\nALL VSS TESTS PASSED")
