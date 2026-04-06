import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

/** Protection status reported to the UI */
export enum ProtectionStatus {
	ACTIVE = "active",
	UNVAILABLE = "unavailable",
	OFF = "off"
}

export enum Platform {
	WINDOWS = "windows",
	MACOS = "macos",
	LINUX = "linux"
}

/**
 * Enables OS-level screen capture protection on the current window.
 * Returns the protection status after the attempt.
 *
 * - Windows/macOS: returns "active" (protection applied by OS)
 * - Linux: returns "unavailable" (no OS support)
 * - Errors: returns "unavailable" (logs the error, does not throw)
 */
export const enableCaptureProtection = async (): Promise<ProtectionStatus> => {
	try {
		const appWindow = getCurrentWebviewWindow();
		await appWindow.setContentProtected(true);

		// setContentProtected is a no-op on Linux — detect and report
		const platform = detectPlatform();

		if (platform === Platform.LINUX) return ProtectionStatus.UNVAILABLE;

		return ProtectionStatus.ACTIVE;
	} catch (err) {
		console.error("[AntiCapture] Failed to enable protection:", err);
		return ProtectionStatus.UNVAILABLE;
	}
};

/**
 * Disables screen capture protection (allows normal screenshots of lobby).
 */
export const disableCaptureProtection = async (): Promise<void> => {
	try {
		const appWindow = getCurrentWebviewWindow();
		await appWindow.setContentProtected(false);
	} catch (err) {
		console.error("[AntiCapture] Failed to disable protection:", err);
	}
};

/**
 * Returns the current platform. Used to determine if protection is available.
 */
export const detectPlatform = (): Platform => {
	const ua = navigator.userAgent.toLowerCase();

	if (ua.includes("windows")) return Platform.WINDOWS;
	if (ua.includes("mac")) return Platform.MACOS;

	return Platform.LINUX;
};
