import { useEffect, useRef, useState } from 'react';
import { useAudioStream } from '../hooks/useAudioStream';
import { AudioVisualizer } from './AudioVisualizer';
import { VoiceSelector } from './VoiceSelector';

interface VoiceChatProps {
  serverUrl: string;
  initialVoicePrompt?: string;
  initialTextPrompt?: string;
  autoStartToken?: number | null;
  showSettingsButton?: boolean;
}

const DEFAULT_PROMPT = 'You are Luca, a wise and friendly assistant. Answer questions in a clear and engaging way.';

interface GpuStats {
  available: boolean;
  name?: string;
  memoryUsedMb?: number;
  memoryTotalMb?: number;
  utilizationGpu?: number;
  reason?: string;
  timestamp?: number;
}

function formatPhaseLabel(phase: string) {
  return phase.split('_').join(' ');
}

export function VoiceChat({
  serverUrl,
  initialVoicePrompt = 'NATF2.pt',
  initialTextPrompt = DEFAULT_PROMPT,
  autoStartToken = null,
  showSettingsButton = true,
}: VoiceChatProps) {
  const [voicePrompt, setVoicePrompt] = useState(initialVoicePrompt);
  const [textPrompt, setTextPrompt] = useState(initialTextPrompt);
  const [showSettings, setShowSettings] = useState(false);
  const [copyLogsStatus, setCopyLogsStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const lastAutoStartTokenRef = useRef<number | null>(null);

  const {
    isConnected,
    isListening,
    isSpeaking,
    error,
    connectionPhase,
    streamLogs,
    tokenStream,
    tokenCount,
    outgoingAudioFrames,
    incomingAudioFrames,
    incomingTextFrames,
    connect,
    disconnect,
  } = useAudioStream({ serverUrl, voicePrompt, textPrompt });

  const [gpuStats, setGpuStats] = useState<GpuStats | null>(null);

  useEffect(() => {
    let mounted = true;

    const pollGpu = async () => {
      try {
        const response = await fetch('/api/diag/gpu', { cache: 'no-store' });
        const payload = (await response.json()) as GpuStats;
        if (mounted) {
          setGpuStats(payload);
        }
      } catch {
        if (mounted) {
          setGpuStats({ available: false, reason: 'request-failed' });
        }
      }
    };

    pollGpu();
    const interval = window.setInterval(pollGpu, 2000);

    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!isConnected) {
      setVoicePrompt(initialVoicePrompt);
      setTextPrompt(initialTextPrompt);
    }
  }, [initialVoicePrompt, initialTextPrompt, isConnected]);

  useEffect(() => {
    if (autoStartToken === null) return;
    if (lastAutoStartTokenRef.current === autoStartToken) return;

    lastAutoStartTokenRef.current = autoStartToken;
    connect();
  }, [autoStartToken, connect]);

  const getStatusText = () => {
    if (error) return error;
    if (!isConnected) return 'Press Start to begin';
    if (isSpeaking) return 'Luca is speaking...';
    if (isListening) return 'Listening...';
    return 'Connected';
  };

  const getStatusColor = () => {
    if (error) return 'text-red-400';
    if (isSpeaking) return 'text-green-400';
    if (isListening) return 'text-yellow-400';
    if (isConnected) return 'text-blue-400';
    return 'text-gray-400';
  };

  const copyAllLogs = async () => {
    const logText = streamLogs.join('\n');
    if (!logText) {
      setCopyLogsStatus('failed');
      window.setTimeout(() => setCopyLogsStatus('idle'), 1500);
      return;
    }

    try {
      await navigator.clipboard.writeText(logText);
      setCopyLogsStatus('copied');
      window.setTimeout(() => setCopyLogsStatus('idle'), 1500);
      return;
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = logText;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'absolute';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();

      try {
        document.execCommand('copy');
        setCopyLogsStatus('copied');
      } catch {
        setCopyLogsStatus('failed');
      } finally {
        document.body.removeChild(textarea);
        window.setTimeout(() => setCopyLogsStatus('idle'), 1500);
      }
    }
  };

  return (
    <div className="flex flex-col items-center justify-center flex-1 p-8">
      {/* Logo/Title */}
      <div className="mb-8 text-center">
        <h1 className="text-4xl font-bold mb-2">
          <span className="text-white">Luca</span>
          <span className="text-[#76b900]"> Express Talk</span>
        </h1>
        <p className="text-gray-400">Human-like voice conversations</p>
      </div>

      {/* Main Circle */}
      <div className="relative mb-8">
        <div 
          className={`
            w-48 h-48 rounded-full flex items-center justify-center
            transition-all duration-300
            ${isConnected 
              ? 'bg-gradient-to-br from-[#76b900] to-[#5a8f00]' 
              : 'bg-gray-800 border-2 border-gray-700'}
            ${isSpeaking ? 'scale-110 shadow-lg shadow-green-500/30' : ''}
          `}
        >
          {isConnected ? (
            <AudioVisualizer isActive={isListening || isSpeaking} />
          ) : (
            <svg className="w-16 h-16 text-gray-500" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
            </svg>
          )}
        </div>
        
        {/* Pulse ring when speaking */}
        {isSpeaking && (
          <div className="absolute inset-0 rounded-full border-4 border-[#76b900] animate-ping opacity-20" />
        )}
      </div>

      {/* Status */}
      <p className={`text-lg mb-6 ${getStatusColor()}`}>
        {getStatusText()}
      </p>

      {/* Controls */}
      <div className="flex gap-4 mb-8">
        {!isConnected ? (
          <button
            onClick={connect}
            className="px-8 py-3 bg-[#76b900] hover:bg-[#5a8f00] text-white font-semibold rounded-full transition-colors"
            aria-label="Start voice conversation"
          >
            Start Talking
          </button>
        ) : (
          <button
            onClick={disconnect}
            className="px-8 py-3 bg-red-600 hover:bg-red-700 text-white font-semibold rounded-full transition-colors"
            aria-label="End voice conversation"
          >
            Stop
          </button>
        )}

        {showSettingsButton && (
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="px-4 py-3 bg-gray-800 hover:bg-gray-700 text-white rounded-full transition-colors"
            aria-label="Toggle settings"
            aria-expanded={showSettings}
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        )}
      </div>

      {/* Settings Panel */}
      {showSettingsButton && showSettings && (
        <div className="w-full max-w-md bg-gray-800 rounded-lg p-6 space-y-4">
          <h2 className="text-lg font-semibold text-white mb-4">Settings</h2>
          
          <VoiceSelector value={voicePrompt} onChange={setVoicePrompt} disabled={isConnected} />
          
          <div>
            <label htmlFor="prompt" className="block text-sm text-gray-400 mb-2">
              Persona Prompt
            </label>
            <textarea
              id="prompt"
              value={textPrompt}
              onChange={(e) => setTextPrompt(e.target.value)}
              disabled={isConnected}
              rows={3}
              className="w-full bg-gray-900 text-white rounded-lg p-3 border border-gray-700 focus:border-[#76b900] focus:outline-none disabled:opacity-50"
              placeholder="Describe the AI persona..."
            />
          </div>
        </div>
      )}

      <div className="w-full max-w-3xl mt-6 bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-4">
        <h2 className="text-lg font-semibold text-white">Runtime Diagnostics</h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="rounded-md border border-gray-800 bg-gray-950/60 p-3">
            <p className="text-xs uppercase tracking-wide text-gray-400">Warm-up phase</p>
            <p className="text-sm text-white mt-1">{formatPhaseLabel(connectionPhase)}</p>
          </div>

          <div className="rounded-md border border-gray-800 bg-gray-950/60 p-3">
            <p className="text-xs uppercase tracking-wide text-gray-400">GPU memory</p>
            <p className="text-sm text-white mt-1">
              {gpuStats?.available
                ? `${gpuStats.memoryUsedMb} MB / ${gpuStats.memoryTotalMb} MB`
                : 'Unavailable'}
            </p>
            {gpuStats?.available && (
              <p className="text-xs text-gray-400 mt-1">{gpuStats.name} · util {gpuStats.utilizationGpu}%</p>
            )}
          </div>

          <div className="rounded-md border border-gray-800 bg-gray-950/60 p-3">
            <p className="text-xs uppercase tracking-wide text-gray-400">Token stream count</p>
            <p className="text-sm text-white mt-1">{tokenCount}</p>
            <p className="text-xs text-gray-400 mt-1">text frames {incomingTextFrames}</p>
          </div>

          <div className="rounded-md border border-gray-800 bg-gray-950/60 p-3">
            <p className="text-xs uppercase tracking-wide text-gray-400">Audio frames</p>
            <p className="text-sm text-white mt-1">out {outgoingAudioFrames} · in {incomingAudioFrames}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="rounded-md border border-gray-800 bg-black/40 p-3">
            <p className="text-sm font-semibold text-white mb-2">Tokens (live)</p>
            <div className="max-h-40 overflow-auto font-mono text-xs text-green-300 whitespace-pre-wrap">
              {tokenStream.length > 0 ? tokenStream : 'No tokens received yet.'}
            </div>
          </div>

          <div className="rounded-md border border-gray-800 bg-black/40 p-3">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-semibold text-white">Stream logs</p>
              <button
                type="button"
                onClick={copyAllLogs}
                className="px-2 py-1 text-xs bg-gray-800 hover:bg-gray-700 text-white rounded transition-colors"
              >
                {copyLogsStatus === 'copied' ? 'Copied' : copyLogsStatus === 'failed' ? 'Copy failed' : 'Copy all logs'}
              </button>
            </div>
            <div className="max-h-40 overflow-auto font-mono text-xs text-gray-300 space-y-1">
              {streamLogs.length > 0 ? (
                streamLogs.map((line, index) => <p key={`${line}-${index}`}>{line}</p>)
              ) : (
                <p className="text-gray-500">No stream logs yet.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
