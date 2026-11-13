/**
 * Checks whether Steam's own embedded browser can play Widevine content.
 * Steam's browser normally ships without Widevine, which is why Netflix and
 * Disney+ fail in PiP plugins built on it.
 */
export async function steamSupportsWidevine(): Promise<boolean> {
  try {
    if (!navigator.requestMediaKeySystemAccess) return false;
    await navigator.requestMediaKeySystemAccess("com.widevine.alpha", [
      {
        initDataTypes: ["cenc"],
        videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }],
        audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }],
      },
    ]);
    return true;
  } catch {
    return false;
  }
}
