"""
CKKS Homomorphic Encryption helpers for Federated Learning.
Uses TenSEAL for packed CKKS operations.
"""

import numpy as np
import tenseal as ts
import torch

from fl_common.model import (
    HE_COEFF_MOD_BITS,
    HE_POLY_MODULUS,
    HE_SCALE_BITS,
    SELECTED_LAYERS,
)


def create_ckks_context() -> ts.Context:
    """Create a fresh CKKS context with Galois keys (needed for rotation)."""
    ctx = ts.context(
        ts.SCHEME_TYPE.CKKS,
        poly_modulus_degree=HE_POLY_MODULUS,
        coeff_mod_bit_sizes=HE_COEFF_MOD_BITS,
    )
    ctx.global_scale = 2**HE_SCALE_BITS
    ctx.generate_galois_keys()
    return ctx


def compute_model_update(
    local_state: dict, global_state: dict
) -> dict[str, torch.Tensor]:
    """Compute ΔW = W_local − W_global for selected layers only."""
    delta: dict[str, torch.Tensor] = {}
    for key in SELECTED_LAYERS:
        if key in local_state and key in global_state:
            diff = local_state[key] - global_state[key]
            diff = torch.clamp(diff, min=-10.0, max=10.0)
            delta[key] = diff
    return delta


def encrypt_update(
    delta: dict[str, torch.Tensor], ctx: ts.Context
) -> tuple[dict[str, ts.CKKSVector], dict[str, tuple]]:
    """Encrypt each layer delta into a CKKS vector."""
    encrypted: dict[str, ts.CKKSVector] = {}
    shapes: dict[str, tuple] = {}

    for key, tensor in delta.items():
        shapes[key] = tensor.shape
        flat = tensor.cpu().detach().numpy().flatten().astype(np.float64)

        # Sanitise
        flat = np.nan_to_num(flat, nan=0.0, posinf=0.0, neginf=0.0)
        flat = np.clip(flat, -10.0, 10.0)

        encrypted[key] = ts.ckks_vector(ctx, flat.tolist())

    return encrypted, shapes


def encrypted_sum(
    encrypted_updates: list[dict[str, ts.CKKSVector]],
) -> dict[str, ts.CKKSVector]:
    """Homomorphic summation of encrypted updates from all clients."""
    if not encrypted_updates:
        return {}

    result: dict[str, ts.CKKSVector] = {}
    all_keys = list(encrypted_updates[0].keys())

    for key in all_keys:
        result[key] = encrypted_updates[0][key]
        for i in range(1, len(encrypted_updates)):
            result[key] = result[key] + encrypted_updates[i][key]

    return result


def decrypt_update(
    enc_sum: dict[str, ts.CKKSVector],
    shapes: dict[str, tuple],
    num_clients: int = 1,
) -> dict[str, torch.Tensor]:
    """Decrypt aggregated update and average by num_clients."""
    decrypted: dict[str, torch.Tensor] = {}

    for key, enc_vec in enc_sum.items():
        flat = np.array(enc_vec.decrypt(), dtype=np.float32)
        flat = np.nan_to_num(flat, nan=0.0, posinf=0.0, neginf=0.0)

        shape = shapes[key]
        num_elements = int(np.prod(shape))
        flat = flat[:num_elements]

        tensor = torch.tensor(flat, dtype=torch.float32).reshape(shape)
        # Average across clients
        tensor /= num_clients
        decrypted[key] = tensor

    return decrypted
