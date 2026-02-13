import { useEffect, useState } from 'react';
import { LauncherPage } from './components/LauncherPage';
import { MaintenancePage } from './components/MaintenancePage';
import { VoiceChat } from './components/VoiceChat';

const DEFAULT_PROMPT = 'You are Luca, a wise and friendly assistant. Answer questions in a clear and engaging way.';

interface SessionConfig {
  voicePrompt: string;
  textPrompt: string;
  autoStartToken: number | null;
}

type ServerUrlSource = 'env' | 'proxy';

function getPreferredLoopbackHost() {
  const currentHost = window.location.hostname;
  return currentHost && currentHost !== 'localhost' ? currentHost : '127.0.0.1';
}

function normalizeLocalhostUrl(rawUrl: string) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname === 'localhost') {
      parsed.hostname = getPreferredLoopbackHost();
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function getCurrentPathname() {
  return window.location.pathname.toLowerCase();
}

function resolveServerConfig(): { url: string; source: ServerUrlSource } {
  const envUrl = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (envUrl && envUrl.trim()) {
    return { url: normalizeLocalhostUrl(envUrl.trim()), source: 'env' };
  }

  // Use the Vite dev-server proxy so the browser never hits the self-signed
  // backend cert directly. The proxy in vite.config.ts forwards /api/chat
  // to wss://localhost:8998 with secure:false.
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const preferredHost = getPreferredLoopbackHost();
  const hostWithPort = window.location.port ? `${preferredHost}:${window.location.port}` : preferredHost;
  return { url: `${protocol}//${hostWithPort}/api/chat`, source: 'proxy' };
}

function App() {
  const serverConfig = resolveServerConfig();
  const [pathname, setPathname] = useState(getCurrentPathname());
  const [serverUrl] = useState(serverConfig.url);
  const [serverUrlSource] = useState<ServerUrlSource>(serverConfig.source);
  const [sessionConfig, setSessionConfig] = useState<SessionConfig>({
    voicePrompt: 'NATF2.pt',
    textPrompt: DEFAULT_PROMPT,
    autoStartToken: null,
  });

  useEffect(() => {
    const onPopState = () => setPathname(getCurrentPathname());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    document.title = 'Luca Express Talk';
  }, []);

  useEffect(() => {
    const savedVoice = window.localStorage.getItem('luca.defaultVoicePrompt');
    const savedText = window.localStorage.getItem('luca.defaultTextPrompt');
    if (!savedVoice && !savedText) return;

    setSessionConfig((previous) => ({
      ...previous,
      voicePrompt: savedVoice || previous.voicePrompt,
      textPrompt: savedText || previous.textPrompt,
    }));
  }, []);

  useEffect(() => {
    window.localStorage.setItem('luca.defaultVoicePrompt', sessionConfig.voicePrompt);
    window.localStorage.setItem('luca.defaultTextPrompt', sessionConfig.textPrompt);
  }, [sessionConfig.voicePrompt, sessionConfig.textPrompt]);

  const navigateTo = (path: string) => {
    if (window.location.pathname === path) {
      setPathname(path);
      return;
    }

    window.history.pushState({}, '', path);
    setPathname(path);
  };

  const handleStart = ({ voicePrompt, textPrompt }: { voicePrompt: string; textPrompt: string }) => {
    setSessionConfig({
      voicePrompt,
      textPrompt,
      autoStartToken: Date.now(),
    });
    navigateTo('/engine');
  };

  const isEnginePage = pathname === '/engine';
  const isMaintenancePage = pathname === '/maintenance';

  return (
    <main className="min-h-screen bg-[#0a0a0a] flex flex-col">
      {isEnginePage ? (
        <>
          <div className="w-full max-w-6xl mx-auto px-4 pt-4">
            <div className="flex items-center gap-4">
              <button
                onClick={() => navigateTo('/')}
                className="text-sm text-gray-400 hover:text-white transition-colors"
                aria-label="Back to launcher"
              >
                ← Back to launcher
              </button>
              <button
                onClick={() => navigateTo('/maintenance')}
                className="text-sm text-gray-400 hover:text-white transition-colors"
                aria-label="Open maintenance and settings"
              >
                Maintenance & Settings
              </button>
            </div>
          </div>
          <VoiceChat
            serverUrl={serverUrl}
            initialVoicePrompt={sessionConfig.voicePrompt}
            initialTextPrompt={sessionConfig.textPrompt}
            autoStartToken={sessionConfig.autoStartToken}
            showSettingsButton={false}
          />
        </>
      ) : isMaintenancePage ? (
        <MaintenancePage
          serverUrl={serverUrl}
          voicePrompt={sessionConfig.voicePrompt}
          textPrompt={sessionConfig.textPrompt}
          onChangeVoicePrompt={(voicePrompt) => setSessionConfig((previous) => ({ ...previous, voicePrompt }))}
          onChangeTextPrompt={(textPrompt) => setSessionConfig((previous) => ({ ...previous, textPrompt }))}
          onBack={() => navigateTo('/')}
        />
      ) : (
        <LauncherPage
          serverUrl={serverUrl}
          serverUrlSource={serverUrlSource}
          defaultVoicePrompt={sessionConfig.voicePrompt}
          defaultTextPrompt={sessionConfig.textPrompt}
          onOpenMaintenance={() => navigateTo('/maintenance')}
          onStart={handleStart}
        />
      )}

      <footer className="text-center py-4 text-gray-500 text-sm">
        Powered by <a href="https://github.com/NVIDIA/personaplex" className="text-[#76b900] hover:underline" target="_blank" rel="noopener">NVIDIA PersonaPlex</a>
      </footer>
    </main>
  )
}

export default App
