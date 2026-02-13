interface AudioVisualizerProps {
  isActive: boolean;
}

export function AudioVisualizer({ isActive }: AudioVisualizerProps) {
  return (
    <div className="flex items-center justify-center gap-1 h-16" aria-hidden="true">
      {[...Array(5)].map((_, i) => (
        <div
          key={i}
          className={`
            w-2 bg-white rounded-full transition-all
            ${isActive ? 'audio-bar h-full' : 'h-2'}
          `}
          style={{
            animationPlayState: isActive ? 'running' : 'paused',
          }}
        />
      ))}
    </div>
  );
}
