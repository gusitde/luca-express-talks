import torch
print(f"torch: {torch.__version__}")
q = torch.randn(1, 8, 16, 64, dtype=torch.bfloat16, device='cuda')
k = torch.randn(1, 8, 16, 64, dtype=torch.bfloat16, device='cuda')
v = torch.randn(1, 8, 16, 64, dtype=torch.bfloat16, device='cuda')
bias = torch.zeros(1, 8, 16, 16, dtype=torch.bfloat16, device='cuda')

# Test with bias (what PersonaPlex uses)
import warnings
with warnings.catch_warnings(record=True) as w:
    warnings.simplefilter("always")
    out = torch.nn.functional.scaled_dot_product_attention(q, k, v, attn_mask=bias)
    print(f"WITH BIAS: {'WARNING: ' + str(w[0].message) if w else 'OK - flash used'}")

# Test without bias
with warnings.catch_warnings(record=True) as w:
    warnings.simplefilter("always")
    out = torch.nn.functional.scaled_dot_product_attention(q, k, v)
    print(f"NO BIAS: {'WARNING: ' + str(w[0].message) if w else 'OK - flash used'}")
