"""
Ed25519 gradient signing and verification for Federated Learning.
Each FL client signs their serialised encrypted gradient before sending it
to the server; the server verifies every signature before accepting a gradient.
"""

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
    load_pem_private_key,
    load_pem_public_key,
)


# ── Key generation ────────────────────────────────────────────────────────────


def generate_keypair() -> tuple[bytes, bytes]:
    """
    Generate an Ed25519 keypair.

    Returns:
        (private_key_pem, public_key_pem) — both PEM-encoded bytes.
    """
    private_key = Ed25519PrivateKey.generate()
    private_key_pem = private_key.private_bytes(
        encoding=Encoding.PEM,
        format=PrivateFormat.PKCS8,
        encryption_algorithm=NoEncryption(),
    )
    public_key_pem = private_key.public_key().public_bytes(
        encoding=Encoding.PEM,
        format=PublicFormat.SubjectPublicKeyInfo,
    )
    return private_key_pem, public_key_pem


# ── Signing ───────────────────────────────────────────────────────────────────


def sign_gradient(
    gradient_bytes: bytes,
    private_key_pem: bytes,
) -> bytes:
    """
    Sign gradient_bytes with the Ed25519 private key.

    Args:
        gradient_bytes: The serialised (encrypted) gradient payload to sign.
        private_key_pem: PEM-encoded Ed25519 private key.

    Returns:
        64-byte Ed25519 signature.
    """
    private_key = load_pem_private_key(private_key_pem, password=None)
    return private_key.sign(gradient_bytes)


# ── Verification ──────────────────────────────────────────────────────────────


def verify_gradient(
    gradient_bytes: bytes,
    signature: bytes,
    public_key_pem: bytes,
) -> bool:
    """
    Verify an Ed25519 signature against gradient_bytes.

    This function never raises — any error (invalid signature, malformed key,
    wrong signature length, etc.) results in a False return value.

    Args:
        gradient_bytes: The serialised gradient payload that was signed.
        signature: The 64-byte Ed25519 signature to check.
        public_key_pem: PEM-encoded Ed25519 public key of the claimed signer.

    Returns:
        True if the signature is valid, False otherwise.
    """
    try:
        public_key = load_pem_public_key(public_key_pem)
        public_key.verify(signature, gradient_bytes)
        return True
    except (InvalidSignature, Exception):
        return False


# ── Self-test ─────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    data = b"test gradient bytes 12345"

    # 1. Generate a keypair.
    priv_pem, pub_pem = generate_keypair()

    # 2. Sign the test payload.
    sig = sign_gradient(data, priv_pem)

    # 3. Valid signature with correct key must return True.
    assert verify_gradient(data, sig, pub_pem), "FAIL: valid sig rejected"

    # 4. Valid signature verified against a *different* public key must return False.
    _, wrong_pub_pem = generate_keypair()
    assert not verify_gradient(data, sig, wrong_pub_pem), "FAIL: wrong key accepted"

    # 5. Tampered data with the original signature must return False.
    assert not verify_gradient(b"tampered data", sig, pub_pem), "FAIL: tampered data accepted"

    # 6. A malformed / wrong-length signature must return False.
    assert not verify_gradient(b"data", b"badsig", pub_pem), "FAIL: bad signature accepted"

    print("ALL SIGNING TESTS PASSED")
