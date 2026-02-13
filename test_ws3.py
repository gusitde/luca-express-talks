"""Sequential WebSocket test - one connection at a time."""
import asyncio
import aiohttp
import time

async def test_single(label, url):
    print(f"\n[{label}] {url}")
    async with aiohttp.ClientSession() as session:
        try:
            t0 = time.time()
            ws = await asyncio.wait_for(
                session.ws_connect(url, heartbeat=None, receive_timeout=None),
                timeout=15,
            )
            print(f"  Connected in {time.time()-t0:.1f}s")

            # Check healthz while waiting
            try:
                async with session.get("http://127.0.0.1:8998/healthz", timeout=aiohttp.ClientTimeout(total=3)) as r:
                    h = await r.json()
                    print(f"  /healthz during wait: {h}")
            except:
                print(f"  /healthz: unavailable")

            print(f"  Waiting for handshake (system prompts ~2-3min with CPU offloading)...")
            while True:
                try:
                    msg = await asyncio.wait_for(ws.receive(), timeout=30)
                except asyncio.TimeoutError:
                    elapsed = time.time() - t0
                    print(f"  ...still waiting ({elapsed:.0f}s elapsed)")
                    if elapsed > 360:
                        print(f"  TIMEOUT after {elapsed:.0f}s")
                        await ws.close()
                        return False
                    continue

                t_total = time.time() - t0

                if msg.type == aiohttp.WSMsgType.BINARY and len(msg.data) > 0:
                    kind = msg.data[0]
                    if kind == 0:
                        print(f"  HANDSHAKE OK in {t_total:.1f}s")
                        import numpy as np
                        silence = np.zeros(24000, dtype=np.float32)
                        await ws.send_bytes(b"\x03" + silence.tobytes())
                        print(f"  Sent 1s silence PCM frame")

                        got_audio = False
                        got_text = False
                        deadline = time.time() + 60
                        while time.time() < deadline:
                            try:
                                rmsg = await asyncio.wait_for(ws.receive(), timeout=10)
                                if rmsg.type == aiohttp.WSMsgType.BINARY and len(rmsg.data) > 0:
                                    rkind = rmsg.data[0]
                                    if rkind == 3 and not got_audio:
                                        got_audio = True
                                        pcm_bytes = len(rmsg.data) - 1
                                        print(f"  RECV audio frame: {pcm_bytes} bytes ({pcm_bytes//4} samples)")
                                    elif rkind == 2:
                                        text = rmsg.data[1:].decode("utf-8", errors="replace")
                                        got_text = True
                                        print(f"  RECV text token: '{text}'")
                                elif rmsg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSING, aiohttp.WSMsgType.CLOSED):
                                    print(f"  Connection closed during audio wait: {rmsg.type}")
                                    break
                                if got_audio and got_text:
                                    break
                            except asyncio.TimeoutError:
                                print(f"  ...waiting for audio/text ({time.time()-t0:.0f}s total)")
                                continue

                        print(f"  AUDIO PIPELINE: {'WORKING' if got_audio else 'no audio received'}")
                        if got_text:
                            print(f"  TEXT PIPELINE: WORKING")
                        await ws.close()
                        return got_audio or got_text
                    else:
                        print(f"  Got kind={kind} (expected 0=handshake)")
                elif msg.type == aiohttp.WSMsgType.CLOSE:
                    print(f"  Server closed at {t_total:.1f}s: code={msg.data} reason={msg.extra}")
                    return False
                elif msg.type == aiohttp.WSMsgType.CLOSING:
                    print(f"  Connection closing at {t_total:.1f}s (heartbeat timeout?)")
                    return False
                elif msg.type == aiohttp.WSMsgType.PING:
                    print(f"  Received PING at {t_total:.1f}s")
                    continue
                else:
                    print(f"  Unexpected: type={msg.type} at {t_total:.1f}s")
                    return False

        except asyncio.TimeoutError:
            print(f"  CONNECT TIMEOUT after {time.time()-t0:.1f}s")
            return False
        except Exception as e:
            print(f"  FAIL: {e}")
            return False

async def main():
    print("=== Sequential WebSocket Test ===")
    ok = await test_single("DIRECT", "http://127.0.0.1:8998/api/chat?audio_format=pcm_f32&voice_prompt=NATF2.pt&text_prompt=You+are+Luca.+Say+hello.&seed=42")
    if ok:
        print("\n*** ALL TESTS PASSED ***")
    else:
        print("\n*** TEST FAILED ***")

asyncio.run(main())
