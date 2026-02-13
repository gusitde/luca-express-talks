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
                session.ws_connect(url),
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

            print(f"  Waiting for handshake (system prompts processing)...")
            msg = await asyncio.wait_for(ws.receive(), timeout=300)
            t_total = time.time() - t0

            if msg.type == aiohttp.WSMsgType.BINARY and len(msg.data) > 0:
                kind = msg.data[0]
                if kind == 0:
                    print(f"  HANDSHAKE OK in {t_total:.1f}s")
                    # Send a few seconds of silence to test the audio pipeline
                    import numpy as np
                    silence = np.zeros(24000, dtype=np.float32)  # 1 second at 24kHz
                    await ws.send_bytes(b"\x03" + silence.tobytes())
                    print(f"  Sent 1s silence PCM frame")

                    # Wait for audio/text response
                    got_audio = False
                    got_text = False
                    deadline = time.time() + 30
                    while time.time() < deadline:
                        try:
                            rmsg = await asyncio.wait_for(ws.receive(), timeout=5)
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
                                print(f"  Connection closed: {rmsg.type}")
                                break
                            if got_audio and got_text:
                                break
                        except asyncio.TimeoutError:
                            break

                    if got_audio:
                        print(f"  AUDIO PIPELINE: WORKING")
                    else:
                        print(f"  AUDIO PIPELINE: no audio received in 30s")
                    if got_text:
                        print(f"  TEXT PIPELINE: WORKING")

                    await ws.close()
                    return True
                else:
                    print(f"  Got kind={kind} (expected 0=handshake)")
            elif msg.type == aiohttp.WSMsgType.CLOSE:
                print(f"  Server closed connection: {msg.data} {msg.extra}")
            elif msg.type == aiohttp.WSMsgType.CLOSING:
                print(f"  Connection closing (lock busy?)")
            else:
                print(f"  Unexpected: type={msg.type}")

            await ws.close()
            return False

        except asyncio.TimeoutError:
            print(f"  TIMEOUT after {time.time()-t0:.1f}s")
            return False
        except Exception as e:
            print(f"  FAIL: {e}")
            return False

async def main():
    print("=== Sequential WebSocket Test ===")
    print("Testing direct backend connection...")

    ok = await test_single("DIRECT", "http://127.0.0.1:8998/api/chat?audio_format=pcm_f32&voice_prompt=NATF2.pt&text_prompt=You+are+Luca.+Say+hello.&seed=42")

    if ok:
        print("\n*** ALL TESTS PASSED ***")
    else:
        print("\n*** TEST FAILED ***")

asyncio.run(main())
