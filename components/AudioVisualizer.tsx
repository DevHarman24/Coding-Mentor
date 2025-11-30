import React from 'react';
import { AudioVisualizerProps } from '../types';

export const AudioVisualizer: React.FC<AudioVisualizerProps> = ({ isSpeaking, volume }) => {
  // Create an array of bars
  const bars = Array.from({ length: 5 });
  
  return (
    <div className="flex items-center justify-center space-x-2 h-16">
      {bars.map((_, i) => {
        // Calculate dynamic height based on volume and index
        // Central bars react more strongly
        const baseHeight = 20;
        const variableHeight = 60;
        const sensitivity = isSpeaking ? (volume * (1.5 - Math.abs(2 - i) * 0.2)) : 0.1;
        const height = Math.min(100, Math.max(10, baseHeight + (variableHeight * sensitivity * 4)));
        
        return (
          <div
            key={i}
            className={`w-3 rounded-full transition-all duration-75 ease-in-out ${isSpeaking ? 'bg-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.5)]' : 'bg-slate-600'}`}
            style={{ 
              height: `${height}%`,
              opacity: isSpeaking ? 1 : 0.5
            }}
          />
        );
      })}
    </div>
  );
};