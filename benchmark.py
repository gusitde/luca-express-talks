import time
import torch
import numpy as np

print("Loading model...")
t0 = time.time()

from moshi.models import loaders

# Load mimi (audio codec)
from huggingface_hub import hf_hub_download
mimi_weight = hf_hub_download("nvidia/personaplex-7b-v1", loaders.MIMI_NAME)
mimi = loaders.get_mimi(mimi_weight, "cuda")
print(f"Mimi loaded in {time.time()-t0:.1f}s")

# Load main model
t1 = time.time()
moshi_weight = hf_hub_download("nvidia/personaplex-7b-v1", loaders.MOSHI_NAME)
lm = loaders.get_moshi_lm(moshi_weight, device="cuda")
lm.eval()
print(f"Moshi loaded in {time.time()-t1:.1f}s")

# Check GPU memory
mem = torch.cuda.memory_allocated() / 1024**3
print(f"GPU memory used: {mem:.2f} GB")

# Create LMGen
from moshi.models.lm import LMGen
lm_gen = LMGen(lm, audio_silence_frame_cnt=6, sample_rate=mimi.sample_rate,
               device="cuda", frame_rate=mimi.frame_rate)

# Start streaming
mimi.streaming_forever(1)
lm_gen.streaming_forever(1)

# Warmup
frame_size = int(mimi.sample_rate / mimi.frame_rate)
for _ in range(4):
    chunk = torch.zeros(1, 1, frame_size, dtype=torch.float32, device="cuda")
    codes = mimi.encode(chunk)
    for c in range(codes.shape[-1]):
        tokens = lm_gen.step(codes[:, :, c:c+1])

torch.cuda.synchronize()
print("Warmup done")
print(f"GPU memory after warmup: {torch.cuda.memory_allocated()/1024**3:.2f} GB")

# Benchmark single step
times = []
for i in range(20):
    torch.cuda.synchronize()
    t = time.time()
    
    chunk = torch.zeros(1, 1, frame_size, dtype=torch.float32, device="cuda")
    codes = mimi.encode(chunk)
    for c in range(codes.shape[-1]):
        tokens = lm_gen.step(codes[:, :, c:c+1])
    
    torch.cuda.synchronize()
    elapsed = time.time() - t
    times.append(elapsed)
    if i < 5 or i % 5 == 0:
        print(f"  Step {i}: {elapsed*1000:.1f} ms")

print(f"\nAverage step time: {np.mean(times[2:])*1000:.1f} ms")
print(f"For 200 steps: {np.mean(times[2:])*200:.1f} seconds")
print(f"For 100 text tokens: {np.mean(times[2:])*100:.1f} seconds")
