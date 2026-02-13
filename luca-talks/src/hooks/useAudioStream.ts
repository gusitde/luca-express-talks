import { useRef, useState, useCallback, useEffect } from 'react';
import Recorder from 'opus-recorder';
import encoderPath from 'opus-recorder/dist/encoderWorker.min.js?url';

export interface AudioStreamState {
  isConnected: boolean;
  isListening: boolean;
  isSpeaking: boolean;
  error: string | null;
}

export type ConnectionPhase =
  | 'idle'
  | 'requesting_microphone'
  | 'opening_websocket'
  | 'connected'
  | 'streaming'
  | 'error';

interface UseAudioStreamOptions {
  serverUrl: string;
  voicePrompt?: string;
  textPrompt?: string;
}

interface OpusRecorderInstance {
  start: () => void;
  stop: () => void;
  ondataavailable: ((data: Uint8Array) => void) | null;
}

type AudioFormatMode = 'opus' | 'pcm_f32';

// System prompts take ~5 min with CPU-offloaded models.
// The WebSocket opens instantly but the server handshake byte
// only arrives after system prompts finish.  The timeout here
// gates the ws.onopen event (HTTP upgrade), NOT the handshake.
const CONNECT_TIMEOUT_MS = 30000;

function getDirectBackendWsUrl(serverUrl: string) {
  const direct = new URL(serverUrl);
  direct.protocol = 'ws:';
  direct.hostname = '127.0.0.1';
  direct.port = '8998';
  direct.pathname = '/api/chat';
  return direct.toString();
}

function withTimestamp(message: string) {
  return `[${new Date().toLocaleTimeString()}] ${message}`;
}

function toDiagnosticHost(serverUrl: string) {
  const parsed = new URL(serverUrl);
  if (parsed.hostname !== 'localhost') return parsed.host;

  const currentHost = window.location.hostname;
  const mappedHost = currentHost && currentHost !== 'localhost' ? currentHost : '127.0.0.1';
  return parsed.port ? `${mappedHost}:${parsed.port}` : mappedHost;
}

export function useAudioStream({ serverUrl, voicePrompt = 'NATF2.pt', textPrompt }: UseAudioStreamOptions) {
  const [state, setState] = useState<AudioStreamState>({
    isConnected: false,
    isListening: false,
    isSpeaking: false,
    error: null,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<OpusRecorderInstance | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const audioQueueRef = useRef<Float32Array[]>([]);
  const isPlayingRef = useRef(false);
  const audioFormatRef = useRef<AudioFormatMode>('pcm_f32');
  const fallbackAttemptedRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const directHostFallbackAttemptedRef = useRef(false);
  const proxyHostFallbackAttemptedRef = useRef(false);
  const useDirectBackendHostRef = useRef(false);
  const preserveModeOnReconnectRef = useRef(false);
  const suppressSocketErrorRef = useRef(false);
  const reconnectScheduledRef = useRef(false);
  const connectInProgressRef = useRef(false);
  const manualDisconnectRef = useRef(false);
  const inboundFramesRef = useRef(0);
  const handshakeReceivedRef = useRef(false);
  const captureStartedRef = useRef(false);
  const connectWatchdogRef = useRef<number | null>(null);
  const [connectionPhase, setConnectionPhase] = useState<ConnectionPhase>('idle');
  const [streamLogs, setStreamLogs] = useState<string[]>([]);
  const [tokenStream, setTokenStream] = useState('');
  const [tokenCount, setTokenCount] = useState(0);
  const [outgoingAudioFrames, setOutgoingAudioFrames] = useState(0);
  const [incomingAudioFrames, setIncomingAudioFrames] = useState(0);
  const [incomingTextFrames, setIncomingTextFrames] = useState(0);

  const appendStreamLog = useCallback((message: string) => {
    const line = withTimestamp(message);
    setStreamLogs((previous) => [...previous, line].slice(-250));
  }, []);

  const cleanup = useCallback(() => {
    if (connectWatchdogRef.current !== null) {
      window.clearTimeout(connectWatchdogRef.current);
      connectWatchdogRef.current = null;
    }

    recorderRef.current?.stop();
    recorderRef.current = null;
    processorRef.current?.disconnect();
    processorRef.current = null;
    mediaStreamRef.current?.getTracks().forEach(t => t.stop());
    audioContextRef.current?.close();

    mediaStreamRef.current = null;
    audioContextRef.current = null;
    audioQueueRef.current = [];
    isPlayingRef.current = false;
    setConnectionPhase('idle');
  }, []);

  const startCapture = useCallback((mode: AudioFormatMode) => {
    if (!wsRef.current) return;

    if (mode === 'pcm_f32') {
      if (!audioContextRef.current || !mediaStreamRef.current) return;

      const ctx = audioContextRef.current;
      const source = ctx.createMediaStreamSource(mediaStreamRef.current);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          const inputData = e.inputBuffer.getChannelData(0);
          const pcmCopy = new Float32Array(inputData);
          const payload = new Uint8Array(pcmCopy.buffer);
          const framed = new Uint8Array(1 + payload.byteLength);
          framed[0] = 3;
          framed.set(payload, 1);
          wsRef.current.send(framed.buffer);
          setOutgoingAudioFrames((previous) => previous + 1);
        }
      };

      source.connect(processor);
      processor.connect(ctx.destination);
      setState(s => ({ ...s, isListening: true }));
      return;
    }

    const recorder = new Recorder({
      mediaTrackConstraints: {
        audio: {
          sampleRate: 24000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      },
      encoderPath,
      bufferLength: 960,
      encoderFrameSize: 20,
      encoderSampleRate: 24000,
      maxFramesPerPage: 2,
      numberOfChannels: 1,
      recordingGain: 1,
      resampleQuality: 3,
      encoderComplexity: 0,
      encoderApplication: 2049,
      streamPages: true,
    });

    recorder.ondataavailable = (data: Uint8Array) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        const framed = new Uint8Array(1 + data.byteLength);
        framed[0] = 1;
        framed.set(data, 1);
        wsRef.current.send(framed.buffer);
        setOutgoingAudioFrames((previous) => previous + 1);
      }
    };

    recorder.start();
    recorderRef.current = recorder;
    setState(s => ({ ...s, isListening: true }));
  }, []);

  const playAudioQueue = useCallback(() => {
    if (isPlayingRef.current || audioQueueRef.current.length === 0) return;
    if (!audioContextRef.current) return;

    isPlayingRef.current = true;
    setState(s => ({ ...s, isSpeaking: true }));

    const playNext = () => {
      if (audioQueueRef.current.length === 0) {
        isPlayingRef.current = false;
        setState(s => ({ ...s, isSpeaking: false }));
        return;
      }

      const audioData = audioQueueRef.current.shift()!;
      const ctx = audioContextRef.current!;
      const buffer = ctx.createBuffer(1, audioData.length, 24000);
      buffer.getChannelData(0).set(audioData);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.onended = playNext;
      source.start();
    };

    playNext();
  }, []);

  const connect = useCallback(async () => {
    if (connectInProgressRef.current) {
      appendStreamLog('INFO connect request ignored (connect already in progress)');
      return;
    }

    connectInProgressRef.current = true;
    try {
      if (!preserveModeOnReconnectRef.current) {
        audioFormatRef.current = 'pcm_f32';
        fallbackAttemptedRef.current = false;
        reconnectAttemptsRef.current = 0;
        directHostFallbackAttemptedRef.current = false;
        proxyHostFallbackAttemptedRef.current = false;
        useDirectBackendHostRef.current = false;
        suppressSocketErrorRef.current = false;
        reconnectScheduledRef.current = false;
      } else {
        preserveModeOnReconnectRef.current = false;
      }

      manualDisconnectRef.current = false;
      inboundFramesRef.current = 0;
      handshakeReceivedRef.current = false;
      captureStartedRef.current = false;
      setState(s => ({ ...s, error: null }));
      setTokenStream('');
      setTokenCount(0);
      setOutgoingAudioFrames(0);
      setIncomingAudioFrames(0);
      setIncomingTextFrames(0);
      appendStreamLog('INFO connect requested');

      if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
        appendStreamLog('INFO closing previous websocket before reconnect');
        wsRef.current.close();
      }

      setConnectionPhase('requesting_microphone');
      appendStreamLog('SEND microphone permission request');

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 24000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      mediaStreamRef.current = stream;
      appendStreamLog('RECV microphone stream granted');

      audioContextRef.current = new AudioContext({ sampleRate: 24000 });

      const targetServerUrl = useDirectBackendHostRef.current ? getDirectBackendWsUrl(serverUrl) : serverUrl;
      const wsUrl = new URL(targetServerUrl);
      const envUrl = import.meta.env.VITE_SERVER_URL as string | undefined;
      const wsSource = envUrl && envUrl.trim()
        ? 'env (VITE_SERVER_URL)'
        : 'proxy default (/api/chat)';
      const diagnosticHost = toDiagnosticHost(serverUrl);
      const audioFormat = audioFormatRef.current;
      wsUrl.searchParams.set('voice_prompt', voicePrompt);
      wsUrl.searchParams.set('audio_format', audioFormat);
      if (textPrompt) {
        wsUrl.searchParams.set('text_prompt', textPrompt);
      }

      const transportSource = useDirectBackendHostRef.current
        ? `${wsSource} + direct-backend-fallback`
        : wsSource;
      appendStreamLog(`INFO websocket URL source=${transportSource} host=${diagnosticHost} audio_format=${audioFormat}`);

      const ws = new WebSocket(wsUrl.toString());
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;
      setConnectionPhase('opening_websocket');
      appendStreamLog(`SEND websocket connect ${wsUrl.toString()}`);
      let connectTimeout: number | null = window.setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          if (!useDirectBackendHostRef.current && !directHostFallbackAttemptedRef.current) {
            directHostFallbackAttemptedRef.current = true;
            useDirectBackendHostRef.current = true;
            preserveModeOnReconnectRef.current = true;
            appendStreamLog('WARN websocket open timeout via proxy, retrying direct backend ws://127.0.0.1:8998/api/chat');
            suppressSocketErrorRef.current = true;
            reconnectScheduledRef.current = true;
            ws.close(4003, 'fallback-direct-host');
            window.setTimeout(() => {
              if (!reconnectScheduledRef.current) return;
              reconnectScheduledRef.current = false;
              connectInProgressRef.current = false;
              void connect();
            }, 200);
            return;
          }

          setState(s => ({ ...s, error: 'Connection timeout: server not ready (check model loading/logs).' }));
          setConnectionPhase('error');
          appendStreamLog('RECV websocket timeout before open');
          ws.close();
        }
      }, CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        if (connectTimeout !== null) {
          window.clearTimeout(connectTimeout);
          connectTimeout = null;
        }
        setState(s => ({ ...s, isConnected: true }));
        connectInProgressRef.current = false;
        setConnectionPhase('connected');
        appendStreamLog('RECV websocket open');

        if (connectWatchdogRef.current !== null) {
          window.clearTimeout(connectWatchdogRef.current);
        }
        connectWatchdogRef.current = window.setTimeout(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (handshakeReceivedRef.current) return;

          appendStreamLog('WARN waiting for server handshake (model/system prompt setup may still be running)');
          if (!captureStartedRef.current) {
            captureStartedRef.current = true;
            startCapture(audioFormatRef.current);
            appendStreamLog(`SEND microphone stream start fallback (${audioFormatRef.current})`);
          }
        }, 12000);
      };

      const handleIncomingBytes = (bytes: Uint8Array) => {
        if (bytes.length === 0) {
          return;
        }

        const kind = bytes[0];

        if (kind === 0) {
          inboundFramesRef.current += 1;
          handshakeReceivedRef.current = true;
          appendStreamLog('RECV server handshake');

          if (!captureStartedRef.current) {
            captureStartedRef.current = true;
            startCapture(audioFormatRef.current);
            appendStreamLog(`SEND microphone stream start (${audioFormatRef.current})`);
          }
          return;
        }

        if (kind === 2) {
          const text = new TextDecoder().decode(bytes.slice(1));
          if (text.length > 0) {
            inboundFramesRef.current += 1;
            setIncomingTextFrames((previous) => previous + 1);
            setTokenStream((previous) => `${previous}${text}`);
            setTokenCount((previous) => previous + 1);
            appendStreamLog(`RECV token chunk: ${text}`);
          }
          return;
        }

        if (kind === 3) {
          const payload = bytes.slice(1);
          if (payload.byteLength % 4 === 0) {
            inboundFramesRef.current += 1;
            setIncomingAudioFrames((previous) => previous + 1);
            const float32Data = new Float32Array(payload.buffer, payload.byteOffset, payload.byteLength / 4);
            audioQueueRef.current.push(new Float32Array(float32Data));
            setConnectionPhase('streaming');
            playAudioQueue();
          } else {
            appendStreamLog(`RECV pcm frame ignored (bytes=${payload.byteLength})`);
          }
          return;
        }

        if (kind === 1) {
          inboundFramesRef.current += 1;
          setIncomingAudioFrames((previous) => previous + 1);
          return;
        }

        appendStreamLog(`RECV unknown frame kind=${kind}`);
      };

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          handleIncomingBytes(new Uint8Array(event.data));
          return;
        }

        if (event.data instanceof Blob) {
          void event.data.arrayBuffer().then((buffer) => {
            handleIncomingBytes(new Uint8Array(buffer));
          }).catch(() => {
            appendStreamLog('RECV blob frame decode error');
          });
        }
      };

      ws.onerror = () => {
        if (connectTimeout !== null) {
          window.clearTimeout(connectTimeout);
          connectTimeout = null;
        }
        if (connectWatchdogRef.current !== null) {
          window.clearTimeout(connectWatchdogRef.current);
          connectWatchdogRef.current = null;
        }
        if (suppressSocketErrorRef.current) {
          appendStreamLog('INFO websocket transient error during fallback switch');
          return;
        }
        setState(s => ({ ...s, error: 'WebSocket connection error' }));
        setConnectionPhase('error');
        appendStreamLog('RECV websocket error');
      };

      ws.onclose = (event) => {
        if (connectTimeout !== null) {
          window.clearTimeout(connectTimeout);
          connectTimeout = null;
        }
        if (connectWatchdogRef.current !== null) {
          window.clearTimeout(connectWatchdogRef.current);
          connectWatchdogRef.current = null;
        }
        setState(s => ({ ...s, isConnected: false, isListening: false }));
        appendStreamLog(`RECV websocket close code=${event.code} reason=${event.reason || 'none'}`);
        cleanup();

        if (reconnectScheduledRef.current) {
          suppressSocketErrorRef.current = false;
          return;
        }
        connectInProgressRef.current = false;
        manualDisconnectRef.current = false;
        suppressSocketErrorRef.current = false;
      };
    } catch (err) {
      connectInProgressRef.current = false;
      setState(s => ({
        ...s,
        error: err instanceof Error ? err.message : 'Failed to connect',
      }));
      setConnectionPhase('error');
      appendStreamLog(`RECV connect exception: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  }, [serverUrl, voicePrompt, textPrompt, startCapture, playAudioQueue, cleanup, appendStreamLog]);

  const disconnect = useCallback(() => {
    manualDisconnectRef.current = true;
    connectInProgressRef.current = false;
    wsRef.current?.close();
    appendStreamLog('SEND disconnect request');
    cleanup();
  }, [cleanup, appendStreamLog]);

  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  return {
    ...state,
    connectionPhase,
    streamLogs,
    tokenStream,
    tokenCount,
    outgoingAudioFrames,
    incomingAudioFrames,
    incomingTextFrames,
    connect,
    disconnect,
  };
}
