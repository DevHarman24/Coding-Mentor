import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { LogMessage, ConnectionState } from './types';
import { MODEL_NAME, SYSTEM_INSTRUCTION } from './constants';
import { decode, decodeAudioData, createBlob } from './utils/audioUtils';
import { AudioVisualizer } from './components/AudioVisualizer';
import { Mic, MicOff, Terminal, Cpu, Info, XCircle } from 'lucide-react';

const App: React.FC = () => {
  // --- State ---
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.DISCONNECTED);
  const [logs, setLogs] = useState<LogMessage[]>([]);
  const [isMicOn, setIsMicOn] = useState(true);
  const [volume, setVolume] = useState(0);
  const [aiVolume, setAiVolume] = useState(0);
  
  // --- Refs for Audio & Session Management ---
  const logsEndRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null); // For future video expansion if needed
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  
  // Helper to add logs
  const addLog = useCallback((text: string, sender: 'user' | 'ai' | 'system') => {
    setLogs((prev) => [
      ...prev,
      {
        id: Math.random().toString(36).substring(7),
        timestamp: new Date(),
        sender,
        text,
      },
    ]);
  }, []);

  // Auto-scroll logs
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  // --- Audio Cleanup ---
  const cleanupAudio = useCallback(() => {
    // Stop all playing audio sources
    audioSourcesRef.current.forEach(source => {
      try { source.stop(); } catch (e) {}
    });
    audioSourcesRef.current.clear();

    // Disconnect Input (Mic)
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }
    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    if (inputAudioContextRef.current) {
      inputAudioContextRef.current.close();
      inputAudioContextRef.current = null;
    }

    // Close Output Context
    if (outputAudioContextRef.current) {
      outputAudioContextRef.current.close();
      outputAudioContextRef.current = null;
    }
    
    // Reset volume state
    setVolume(0);
    setAiVolume(0);
  }, []);

  // --- Connect to Gemini Live ---
  const connectToGemini = async () => {
    try {
      setConnectionState(ConnectionState.CONNECTING);
      addLog("Initializing audio contexts...", 'system');

      // 1. Setup Audio Contexts
      // Input: 16kHz for Gemini
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      inputAudioContextRef.current = inputCtx;
      
      // Output: 24kHz for Gemini response
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      outputAudioContextRef.current = outputCtx;

      // 2. Get User Media
      addLog("Requesting microphone access...", 'system');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      // 3. Initialize Gemini Client
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      addLog("Connecting to Gemini Live API...", 'system');
      
      // 4. Create Session
      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: SYSTEM_INSTRUCTION,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
        },
        callbacks: {
          onopen: () => {
            addLog("Connected! Start speaking to CodeCompanion.", 'system');
            setConnectionState(ConnectionState.CONNECTED);
            nextStartTimeRef.current = outputCtx.currentTime;

            // --- Setup Input Processing ---
            const source = inputCtx.createMediaStreamSource(stream);
            sourceNodeRef.current = source;
            
            // Use ScriptProcessor for raw PCM access (bufferSize, inputChannels, outputChannels)
            const processor = inputCtx.createScriptProcessor(4096, 1, 1);
            processorRef.current = processor;

            processor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              
              // Simple volume meter logic
              let sum = 0;
              for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
              const rms = Math.sqrt(sum / inputData.length);
              setVolume(rms * 5); // Amplify for visual

              // Send to Gemini
              const pcmBlob = createBlob(inputData);
              if (sessionPromiseRef.current) {
                sessionPromiseRef.current.then((session) => {
                  session.sendRealtimeInput({ media: pcmBlob });
                });
              }
            };

            source.connect(processor);
            processor.connect(inputCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle Audio Output
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio) {
              try {
                // Determine playback time (gapless)
                nextStartTimeRef.current = Math.max(
                    nextStartTimeRef.current,
                    outputCtx.currentTime
                );

                const audioBuffer = await decodeAudioData(
                  decode(base64Audio),
                  outputCtx,
                  24000,
                  1
                );

                const source = outputCtx.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(outputCtx.destination);
                
                // Visualizer for AI
                const analyser = outputCtx.createAnalyser();
                analyser.fftSize = 32;
                source.connect(analyser);
                const dataArray = new Uint8Array(analyser.frequencyBinCount);
                
                const updateAiVol = () => {
                    analyser.getByteFrequencyData(dataArray);
                    let sum = 0;
                    dataArray.forEach(v => sum += v);
                    const avg = sum / dataArray.length;
                    setAiVolume(avg / 128); // Normalize roughly
                    if(connectionState === ConnectionState.CONNECTED) {
                         requestAnimationFrame(updateAiVol);
                    }
                }
                updateAiVol();

                source.addEventListener('ended', () => {
                    audioSourcesRef.current.delete(source);
                    setAiVolume(0);
                });

                source.start(nextStartTimeRef.current);
                nextStartTimeRef.current += audioBuffer.duration;
                audioSourcesRef.current.add(source);

              } catch (err) {
                console.error("Error decoding audio:", err);
              }
            }

            // Handle Turn Completion (Logging purposes)
            if (message.serverContent?.turnComplete) {
               // We could log that a turn completed, but without transcription enabled 
               // in config, we don't get text here. 
               // For this demo, we are audio-only as per persona "Voice App".
            }
            
            // Handle Interruption
            if (message.serverContent?.interrupted) {
                addLog("User interrupted AI.", 'system');
                audioSourcesRef.current.forEach(source => source.stop());
                audioSourcesRef.current.clear();
                nextStartTimeRef.current = outputCtx.currentTime;
            }
          },
          onclose: () => {
            addLog("Session closed.", 'system');
            setConnectionState(ConnectionState.DISCONNECTED);
            cleanupAudio();
          },
          onerror: (err) => {
            console.error(err);
            addLog(`Error: ${err.message || 'Unknown error'}`, 'system');
            setConnectionState(ConnectionState.ERROR);
            cleanupAudio();
          }
        }
      });
      
      sessionPromiseRef.current = sessionPromise;

    } catch (error: any) {
      console.error(error);
      addLog(`Failed to connect: ${error.message}`, 'system');
      setConnectionState(ConnectionState.ERROR);
      cleanupAudio();
    }
  };

  const handleDisconnect = async () => {
    if (sessionPromiseRef.current) {
        addLog("Disconnecting...", 'system');
        const session = await sessionPromiseRef.current;
        // There isn't a direct "close" on the session object in the SDK types provided 
        // effectively, but stopping the tracks and context kills the stream logic.
        // We trigger cleanup.
        cleanupAudio();
        // Force state update
        setConnectionState(ConnectionState.DISCONNECTED);
        sessionPromiseRef.current = null;
    }
  };

  const toggleMic = () => {
    if (mediaStreamRef.current) {
      const audioTrack = mediaStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMicOn(audioTrack.enabled);
        addLog(audioTrack.enabled ? "Microphone unmuted." : "Microphone muted.", 'system');
      }
    }
  };

  return (
    <div className="min-h-screen bg-[#0f172a] text-slate-200 flex flex-col font-sans selection:bg-cyan-500/30">
      
      {/* Header */}
      <header className="border-b border-slate-800 bg-[#0f172a]/80 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-gradient-to-tr from-cyan-500 to-blue-600 rounded-lg shadow-lg shadow-cyan-500/20">
              <Terminal size={24} className="text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-white">CodeCompanion</h1>
              <p className="text-xs text-slate-400 font-mono">B.Tech Mentor • Live Audio</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${connectionState === ConnectionState.CONNECTED ? 'bg-green-500 animate-pulse' : 'bg-slate-600'}`}></span>
            <span className="text-sm font-medium text-slate-400 uppercase tracking-wider">{connectionState}</span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-4xl w-full mx-auto p-6 flex flex-col gap-6">
        
        {/* Status Card / Visualizer */}
        <div className="relative overflow-hidden rounded-2xl bg-[#1e293b] border border-slate-700 p-8 shadow-2xl">
            <div className="absolute top-0 right-0 p-4 opacity-10">
                <Cpu size={120} />
            </div>
            
            <div className="relative z-10 flex flex-col items-center justify-center min-h-[200px] gap-8">
                {connectionState === ConnectionState.DISCONNECTED && (
                    <div className="text-center space-y-4">
                        <div className="inline-flex items-center justify-center p-4 rounded-full bg-slate-800 mb-2">
                            <MicOff size={32} className="text-slate-500" />
                        </div>
                        <p className="text-slate-400 text-lg">Ready to connect. Click start to talk to your mentor.</p>
                    </div>
                )}

                {connectionState === ConnectionState.CONNECTING && (
                    <div className="flex flex-col items-center gap-4">
                        <div className="w-12 h-12 border-4 border-cyan-500 border-t-transparent rounded-full animate-spin"></div>
                        <p className="text-cyan-400 font-mono animate-pulse">ESTABLISHING UPLINK...</p>
                    </div>
                )}

                {connectionState === ConnectionState.CONNECTED && (
                    <div className="flex flex-col md:flex-row items-center justify-around w-full gap-12">
                        {/* User Visualizer */}
                        <div className="flex flex-col items-center gap-3">
                            <span className="text-xs font-mono text-slate-500 uppercase tracking-widest">You</span>
                            <div className={`p-6 rounded-full transition-colors duration-300 ${isMicOn ? 'bg-slate-800' : 'bg-red-900/20'}`}>
                                <AudioVisualizer isSpeaking={volume > 0.01 && isMicOn} volume={volume} />
                            </div>
                            <div className="h-6">
                                {!isMicOn && <span className="text-xs text-red-400 font-bold flex items-center gap-1"><MicOff size={10}/> MUTED</span>}
                            </div>
                        </div>

                        {/* AI Visualizer */}
                        <div className="flex flex-col items-center gap-3">
                            <span className="text-xs font-mono text-cyan-500 uppercase tracking-widest">CodeCompanion</span>
                            <div className="p-6 rounded-full bg-slate-800 shadow-[0_0_30px_rgba(6,182,212,0.1)]">
                                <AudioVisualizer isSpeaking={aiVolume > 0.01} volume={aiVolume} />
                            </div>
                            <div className="h-6">
                                {aiVolume > 0.01 && <span className="text-xs text-cyan-400 font-mono animate-pulse">SPEAKING...</span>}
                            </div>
                        </div>
                    </div>
                )}
                
                 {connectionState === ConnectionState.ERROR && (
                    <div className="text-center space-y-4 text-red-400">
                        <XCircle size={48} className="mx-auto" />
                        <p>Connection failed. Check console or try again.</p>
                    </div>
                )}
            </div>
        </div>

        {/* Controls */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {connectionState === ConnectionState.CONNECTED ? (
                <button 
                    onClick={handleDisconnect}
                    className="flex items-center justify-center gap-2 p-4 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/50 rounded-xl font-bold transition-all active:scale-95"
                >
                    Disconnect
                </button>
            ) : (
                <button 
                    onClick={connectToGemini}
                    disabled={connectionState === ConnectionState.CONNECTING}
                    className="flex items-center justify-center gap-2 p-4 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white rounded-xl font-bold shadow-lg shadow-cyan-900/50 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {connectionState === ConnectionState.CONNECTING ? 'Connecting...' : 'Start Session'}
                </button>
            )}

            <button 
                onClick={toggleMic}
                disabled={connectionState !== ConnectionState.CONNECTED}
                className={`flex items-center justify-center gap-2 p-4 border rounded-xl font-bold transition-all active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed ${
                    !isMicOn ? 'bg-red-500 text-white border-red-600' : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'
                }`}
            >
                {isMicOn ? <><Mic size={20} /> Mute Mic</> : <><MicOff size={20} /> Unmute Mic</>}
            </button>
        </div>

        {/* Logs Console */}
        <div className="flex-1 bg-black rounded-xl border border-slate-800 p-4 font-mono text-sm overflow-hidden flex flex-col min-h-[200px] shadow-inner">
            <div className="flex items-center gap-2 text-slate-500 mb-2 pb-2 border-b border-slate-900">
                <Terminal size={14} />
                <span className="text-xs uppercase tracking-wider">System Logs</span>
            </div>
            <div className="flex-1 overflow-y-auto space-y-2 pr-2">
                {logs.length === 0 && <span className="text-slate-600 italic">No logs yet...</span>}
                {logs.map((log) => (
                    <div key={log.id} className="flex gap-2 text-xs md:text-sm">
                        <span className="text-slate-600 select-none">[{log.timestamp.toLocaleTimeString()}]</span>
                        <span className={`${
                            log.sender === 'system' ? 'text-yellow-500' : 
                            log.sender === 'user' ? 'text-green-400' : 'text-cyan-400'
                        }`}>
                            {log.sender === 'system' ? '> ' : log.sender === 'user' ? 'USER: ' : 'AI: '}
                            {log.text}
                        </span>
                    </div>
                ))}
                <div ref={logsEndRef} />
            </div>
        </div>
        
        <div className="flex items-center gap-2 text-slate-500 text-xs justify-center">
            <Info size={12} />
            <span>Using model: <span className="text-slate-400">{MODEL_NAME}</span></span>
        </div>

      </main>
    </div>
  );
};

export default App;