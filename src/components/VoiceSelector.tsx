interface VoiceSelectorProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

const VOICES = [
  { id: 'NATF0.pt', name: 'Natural Female 1', category: 'Natural' },
  { id: 'NATF1.pt', name: 'Natural Female 2', category: 'Natural' },
  { id: 'NATF2.pt', name: 'Natural Female 3', category: 'Natural' },
  { id: 'NATF3.pt', name: 'Natural Female 4', category: 'Natural' },
  { id: 'NATM0.pt', name: 'Natural Male 1', category: 'Natural' },
  { id: 'NATM1.pt', name: 'Natural Male 2', category: 'Natural' },
  { id: 'NATM2.pt', name: 'Natural Male 3', category: 'Natural' },
  { id: 'NATM3.pt', name: 'Natural Male 4', category: 'Natural' },
  { id: 'VARF0.pt', name: 'Variety Female 1', category: 'Variety' },
  { id: 'VARF1.pt', name: 'Variety Female 2', category: 'Variety' },
  { id: 'VARF2.pt', name: 'Variety Female 3', category: 'Variety' },
  { id: 'VARF3.pt', name: 'Variety Female 4', category: 'Variety' },
  { id: 'VARF4.pt', name: 'Variety Female 5', category: 'Variety' },
  { id: 'VARM0.pt', name: 'Variety Male 1', category: 'Variety' },
  { id: 'VARM1.pt', name: 'Variety Male 2', category: 'Variety' },
  { id: 'VARM2.pt', name: 'Variety Male 3', category: 'Variety' },
  { id: 'VARM3.pt', name: 'Variety Male 4', category: 'Variety' },
  { id: 'VARM4.pt', name: 'Variety Male 5', category: 'Variety' },
];

export function VoiceSelector({ value, onChange, disabled }: VoiceSelectorProps) {
  const categories = [...new Set(VOICES.map(v => v.category))];

  return (
    <div>
      <label htmlFor="voice" className="block text-sm text-gray-400 mb-2">
        Voice
      </label>
      <select
        id="voice"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="w-full bg-gray-900 text-white rounded-lg p-3 border border-gray-700 focus:border-[#76b900] focus:outline-none disabled:opacity-50 cursor-pointer"
      >
        {categories.map(category => (
          <optgroup key={category} label={category}>
            {VOICES.filter(v => v.category === category).map(voice => (
              <option key={voice.id} value={voice.id}>
                {voice.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}
