import { MessageType } from "../types/signaling";
import { signalingService } from "./signaling";

const ICE_SERVERS = [
	{ urls: "stun:stun.l.google.com:19302" }
	// Add TURN credentials here for production:
	// { urls: "turn:your-turn-server.com:3478", username: "user", credential: "pass" }
];

export class WebRTCService {
	private pc: RTCPeerConnection | null = null;
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
		const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

		// Trickle ICE: send candidates as they're discovered
		pc.onicecandidate = ({ candidate }) => {
			if (candidate) {
				signalingService.send(MessageType.ICE, candidate.toJSON());
			}
		};

		// Deliver the remote stream to the UI
		pc.ontrack = ({ streams }) => {
			if (streams[0] && this.onRemoteStream) {
				this.onRemoteStream(streams[0]);
			}
		};

		pc.onconnectionstatechange = () => {
			if (this.onConnectionStateChange) {
				this.onConnectionStateChange(pc.connectionState);
			}
		};

		if (!this.localStream) return pc;

		// Add local tracks BEFORE creating an offer
		// (the SDP must contain media sections for the tracks to be negotiated)
		for (const track of this.localStream.getTracks()) {
			pc.addTrack(track, this.localStream);
		}

		return pc;
	}

	/** Caller side: create and send an offer */
	public async createOffer(): Promise<void> {
		this.pc = this.createPeerConnection();
		const offer = await this.pc.createOffer();
		await this.pc.setLocalDescription(offer);
		signalingService.send(MessageType.OFFER, {
			sdp: offer.sdp,
			type: offer.type
		});
	}

	/** Callee side: receive offer, create and send answer */
	public async handleOffer(sdp: string, type: RTCSdpType): Promise<void> {
		this.pc = this.createPeerConnection();

		await this.pc.setRemoteDescription({ sdp, type });

		const answer = await this.pc.createAnswer();

		await this.pc.setLocalDescription(answer);

		signalingService.send(MessageType.ANSWER, {
			sdp: answer.sdp,
			type: answer.type
		});
	}

	/** Both sides: apply the answer when received */
	public async handleAnswer(sdp: string, type: RTCSdpType): Promise<void> {
		await this.pc?.setRemoteDescription({ sdp, type });
	}

	/** Both sides: apply ICE candidates as they arrive */
	public async handleIceCandidate(
		candidate: RTCIceCandidateInit
	): Promise<void> {
		await this.pc?.addIceCandidate(candidate);
	}

	/** Hang up and clean up */
	public hangUp(): void {
		for (const track of this.localStream?.getTracks() ?? []) {
			track.stop();
		}

		this.pc?.close();
		this.pc = null;
		this.localStream = null;

		signalingService.send(MessageType.LEAVE, {});
	}
}

export const webrtcService = new WebRTCService();
