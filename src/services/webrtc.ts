import { MessageType } from "../types/signaling";
import { signalingService } from "./signaling";

const ICE_SERVERS = [
	{ urls: "stun:stun.l.google.com:19302" }
	// Add TURN credentials here for production:
	// { urls: "turn:your-turn-server.com:3478", username: "user", credential: "pass" }
];

export class WebRTCService {
	private peerConnection: RTCPeerConnection | null = null;
	private localStream: MediaStream | null = null;

	public onRemoteStream: ((stream: MediaStream) => void) | null = null;
	public onConnectionStateChange:
		| ((state: RTCPeerConnectionState) => void)
		| null = null;

	/** Call this before createOffer or handleOffer */
	public setLocalStream(stream: MediaStream): void {
		this.localStream = stream;
	}

	private createPeerConnection(): RTCPeerConnection {
		const peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

		// Trickle ICE: send candidates as they're discovered
		peerConnection.onicecandidate = ({ candidate }) => {
			if (candidate) {
				signalingService.send(MessageType.ICE, candidate.toJSON());
			}
		};

		// Deliver the remote stream to the UI
		peerConnection.ontrack = ({ streams }) => {
			if (streams[0] && this.onRemoteStream) {
				this.onRemoteStream(streams[0]);
			}
		};

		peerConnection.onconnectionstatechange = () => {
			if (this.onConnectionStateChange) {
				this.onConnectionStateChange(peerConnection.connectionState);
			}
		};

		if (!this.localStream) return peerConnection;

		// Add local tracks BEFORE creating an offer
		// (the SDP must contain media sections for the tracks to be negotiated)
		for (const track of this.localStream.getTracks()) {
			peerConnection.addTrack(track, this.localStream);
		}

		return peerConnection;
	}

	/** Caller side: create and send an offer */
	public async createOffer(): Promise<void> {
		this.peerConnection = this.createPeerConnection();
		const offer = await this.peerConnection.createOffer();
		await this.peerConnection.setLocalDescription(offer);

		signalingService.send(MessageType.OFFER, {
			sdp: offer.sdp,
			type: offer.type
		});
	}

	/** Callee side: receive offer, create and send answer */
	public async handleOffer(sdp: string, type: RTCSdpType): Promise<void> {
		this.peerConnection = this.createPeerConnection();

		await this.peerConnection.setRemoteDescription({ sdp, type });

		const answer = await this.peerConnection.createAnswer();

		await this.peerConnection.setLocalDescription(answer);

		signalingService.send(MessageType.ANSWER, {
			sdp: answer.sdp,
			type: answer.type
		});
	}

	/** Both sides: apply the answer when received */
	public async handleAnswer(sdp: string, type: RTCSdpType): Promise<void> {
		await this.peerConnection?.setRemoteDescription({ sdp, type });
	}

	/** Both sides: apply ICE candidates as they arrive */
	public async handleIceCandidate(
		candidate: RTCIceCandidateInit
	): Promise<void> {
		await this.peerConnection?.addIceCandidate(candidate);
	}

	/** Hang up and clean up */
	public hangUp(): void {
		for (const track of this.localStream?.getTracks() ?? []) {
			track.stop();
		}

		this.peerConnection?.close();
		this.peerConnection = null;
		this.localStream = null;

		signalingService.disconnect();
	}
}

export const webrtcService = new WebRTCService();
