export interface LogMessage {
  id: string;
  timestamp: Date;
  sender: 'user' | 'ai' | 'system';
  text: string;
}

export enum ConnectionState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR',
}

export interface AudioVisualizerProps {
  isSpeaking: boolean;
  volume: number; // 0 to 1
}