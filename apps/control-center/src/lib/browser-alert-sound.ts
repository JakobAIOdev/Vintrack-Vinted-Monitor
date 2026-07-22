const ALERT_MASTER_GAIN = 0.18;

let audioContext: AudioContext | null = null;

function getAudioContextConstructor() {
    if (typeof window === "undefined") return null;

    return (
        window.AudioContext ||
        (
            window as typeof window & {
                webkitAudioContext?: typeof AudioContext;
            }
        ).webkitAudioContext ||
        null
    );
}

function getOrCreateAudioContext() {
    if (audioContext && audioContext.state !== "closed") {
        return audioContext;
    }

    const AudioContextConstructor = getAudioContextConstructor();
    if (!AudioContextConstructor) return null;

    audioContext = new AudioContextConstructor();
    return audioContext;
}

export async function unlockBrowserAlertSound() {
    const context = getOrCreateAudioContext();
    if (!context) return false;

    if (context.state === "suspended") {
        try {
            await context.resume();
        } catch {
            return false;
        }
    }

    return context.state === "running";
}

function scheduleChimePartial({
    context,
    destination,
    frequency,
    startAt,
    duration,
    level,
}: {
    context: AudioContext;
    destination: AudioNode;
    frequency: number;
    startAt: number;
    duration: number;
    level: number;
}) {
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    const stopAt = startAt + duration;

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, startAt);
    envelope.gain.setValueAtTime(0.0001, startAt);
    envelope.gain.exponentialRampToValueAtTime(level, startAt + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, stopAt);

    oscillator.connect(envelope);
    envelope.connect(destination);
    oscillator.start(startAt);
    oscillator.stop(stopAt + 0.02);
}

export function playBrowserAlertSound() {
    const context = getOrCreateAudioContext();
    if (!context || context.state !== "running") return false;

    const now = context.currentTime + 0.015;
    const master = context.createGain();
    master.gain.setValueAtTime(ALERT_MASTER_GAIN, now);
    master.connect(context.destination);

    const notes = [
        { frequency: 659.25, offset: 0, duration: 0.42, level: 0.52 },
        { frequency: 987.77, offset: 0.11, duration: 0.58, level: 0.46 },
    ];

    for (const note of notes) {
        const startAt = now + note.offset;
        scheduleChimePartial({
            context,
            destination: master,
            frequency: note.frequency,
            startAt,
            duration: note.duration,
            level: note.level,
        });
        scheduleChimePartial({
            context,
            destination: master,
            frequency: note.frequency * 2.01,
            startAt,
            duration: note.duration * 0.72,
            level: note.level * 0.12,
        });
    }

    window.setTimeout(() => master.disconnect(), 900);
    return true;
}

export async function closeBrowserAlertSound() {
    const context = audioContext;
    audioContext = null;

    if (!context || context.state === "closed") return;

    try {
        await context.close();
    } catch {
        // The context may already be closing during navigation.
    }
}
