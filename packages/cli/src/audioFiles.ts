/**
 * The master files the CLI offers and picks up from a folder: RIFF WAV / BWF,
 * BW64 and RF64, the containers the converter reads. Sony Wave64 (`.w64`) is a
 * different container the converter cannot read, so it is left out.
 */
export const AUDIO_FILE = /\.(wav|bwf|bw64|rf64)$/i;
