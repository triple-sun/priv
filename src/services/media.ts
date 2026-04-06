export const getLocalStream = async (): Promise<MediaStream> => {
	try {
		return await navigator.mediaDevices.getUserMedia({
			video: { width: 640, height: 480, frameRate: 30 },
			audio: true
		});
	} catch (err) {
		if (err instanceof DOMException) {
			switch (err.name) {
				case "NotAllowedError":
					throw new Error(
						"Camera/microphone permission denied. Please allow access in your browser settings."
					);
				case "NotFoundError":
					throw new Error(
						"No camera or microphone found. Please connect a device and try again."
					);
				case "NotReadableError":
					throw new Error(
						"Camera/microphone is being used by another application. Please close the other application and try again."
					);
			}
		}
		throw err;
	}
};
