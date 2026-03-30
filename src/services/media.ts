export async function getLocalStream(): Promise<MediaStream> {
	try {
		return await navigator.mediaDevices.getUserMedia({
			video: { width: 1280, height: 720, frameRate: 30 },
			audio: true
		});
	} catch (err) {
		if (err instanceof DOMException) {
			if (err.name === "NotAllowedError") {
				throw new Error(
					"Camera/microphone permission denied. Please allow access in your browser settings."
				);
			}
			if (err.name === "NotFoundError") {
				throw new Error(
					"No camera or microphone found. Please connect a device and try again."
				);
			}
		}
		throw err;
	}
}
