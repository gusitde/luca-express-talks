"""Quick WebSocket connectivity test for the Vite proxy → backend chain."""
import asyncio
import aiohttp
import time

async def test():
    print("=== WebSocket Connectivity Test ===")
    
    # Test 1: Backend healthz (direct)
    print("\n[1] Direct backend /healthz...")
    async with aiohttp.ClientSession() as session:
        try:
            async with session.get("http://127.0.0.1:8998/healthz", timeout=aiohttp.ClientTimeout(total=5)) as resp:
                data = await resp.json()
                print(f"    OK: {data}")
        except Exception as e:
            print(f"    FAIL: {e}")
            return
    
    # Test 2: Proxy healthz
    print("\n[2] Proxy → backend /healthz...")
    async with aiohttp.ClientSession() as session:
        try:
            async with session.get("http://localhost:5173/api/diag/server/status", timeout=aiohttp.ClientTimeout(total=5)) as resp:
                data = await resp.json()
                print(f"    OK: responsive={data.get('backendResponsive')}, phase={data.get('phase')}, lockLocked={data.get('lockLocked')}")
        except Exception as e:
            print(f"    FAIL: {e}")
    
    # Test 3: WebSocket through proxy
    print("\n[3] WebSocket via proxy (localhost:5173/api/chat)...")
    async with aiohttp.ClientSession() as session:
        try:
            t0 = time.time()
            ws = await asyncio.wait_for(
                session.ws_connect(
                    "http://localhost:5173/api/chat?audio_format=pcm_f32&voice_prompt=NATF2.pt&text_prompt=Hello&seed=42",
                ),
                timeout=15,
            )
            t_connect = time.time() - t0
            print(f"    Connected in {t_connect:.1f}s")
            
            # Wait for handshake (system prompts run in executor now)
            print("    Waiting for handshake (system prompts processing)...")
            msg = await asyncio.wait_for(ws.receive(), timeout=300)
            t_handshake = time.time() - t0
            
            if msg.type == aiohttp.WSMsgType.BINARY and len(msg.data) > 0:
                kind = msg.data[0]
                if kind == 0:
                    print(f"    HANDSHAKE received in {t_handshake:.1f}s")
                else:
                    print(f"    Got binary kind={kind} in {t_handshake:.1f}s (expected handshake kind=0)")
            elif msg.type == aiohttp.WSMsgType.CLOSE:
                print(f"    Connection closed by server: {msg.data}")
            else:
                print(f"    Unexpected message type: {msg.type}")
            
            await ws.close()
            print("    PASSED")
        except asyncio.TimeoutError:
            print(f"    TIMEOUT after {time.time()-t0:.1f}s")
        except Exception as e:
            print(f"    FAIL: {e}")
    
    # Test 4: Direct WebSocket
    print("\n[4] WebSocket direct (127.0.0.1:8998/api/chat)...")
    async with aiohttp.ClientSession() as session:
        try:
            t0 = time.time()
            ws = await asyncio.wait_for(
                session.ws_connect(
                    "http://127.0.0.1:8998/api/chat?audio_format=pcm_f32&voice_prompt=NATF2.pt&text_prompt=Hello&seed=42",
                ),
                timeout=15,
            )
            t_connect = time.time() - t0
            print(f"    Connected in {t_connect:.1f}s")
            
            print("    Waiting for handshake...")
            msg = await asyncio.wait_for(ws.receive(), timeout=300)
            t_handshake = time.time() - t0
            
            if msg.type == aiohttp.WSMsgType.BINARY and len(msg.data) > 0:
                kind = msg.data[0]
                if kind == 0:
                    print(f"    HANDSHAKE received in {t_handshake:.1f}s")
                else:
                    print(f"    Got binary kind={kind} in {t_handshake:.1f}s")
            elif msg.type == aiohttp.WSMsgType.CLOSE:
                print(f"    Connection closed by server: {msg.data}")
            else:
                print(f"    Unexpected message type: {msg.type}")
            
            await ws.close()
            print("    PASSED")
        except asyncio.TimeoutError:
            print(f"    TIMEOUT after {time.time()-t0:.1f}s")
        except Exception as e:
            print(f"    FAIL: {e}")
    
    print("\n=== Done ===")

asyncio.run(test())
