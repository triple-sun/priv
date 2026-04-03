import { useCallback, useEffect, useRef, useState } from "react";
import { signalingService } from "./services/signaling";
import {
	type AnyEnvelope,
	type Envelope,
	MessageType
} from "./types/signaling";
import "./App.css";
import { getLocalStream } from "./services/media";
import { webrtcService } from "./services/webrtc";

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: <temp UI>
function App() {
	const [status, setStatus] = useState<
		"disconnected" | "connecting" | "connected"
	>("disconnected");
	const [roomId, setRoomId] = useState("");
	const [token, setToken] = useState("");
	const [inRoom, setInRoom] = useState(false);

	const [messages, setMessages] = useState<AnyEnvelope[]>([]);
	const [outgoingMsg, setOutgoingMsg] = useState("");

	const [connectionState, setConnectionState] =
		useState<RTCPeerConnectionState>();

	const [localStream, setLocalStream] = useState<MediaStream>();

	const localVideoRef = useRef<HTMLVideoElement>(null);
	const remoteVideoRef = useRef<HTMLVideoElement>(null);

	const endOfMessagesRef = useRef<HTMLDivElement>(null);

	const address = import.meta.env.VITE_SIGNALING_ADDRESS ?? "localhost";
	const port = import.meta.env.VITE_SIGNALING_PORT ?? "8080";

	const handleHangUp = useCallback(() => {
		webrtcService.hangUp();
	}, []);

	const handleJoin = (e: React.SubmitEvent) => {
		e.preventDefault();
		if (!roomId.trim()) return;

		setMessages([]);
		signalingService.joinRoom(roomId, token.trim() || undefined);
	};

	const handleDisconnectAction = () => {
		signalingService.disconnect();
		setInRoom(false);
		setStatus("disconnected");
		setToken("");

		// Auto-reconnect purely for rapid testing in this lobby
		setTimeout(() => {
			signalingService.connect(`ws://${address}:${port}/ws`);
			setStatus("connected");
		}, 500);
	};

	const handleSendMessage = (e: React.SubmitEvent) => {
		e.preventDefault();
		if (!outgoingMsg.trim() || !inRoom) return;

		// We use "offer" here as a generic placeholder for testing message exchange
		signalingService.send(MessageType.OFFER, { text: outgoingMsg });
		setOutgoingMsg("");
	};

	const handleMicToggle = (e: React.MouseEvent) => {
		e.preventDefault();
		if (!localStream) return;

		for (const t of localStream.getAudioTracks()) {
			t.enabled = !t.enabled;
		}
	};

	const handleCameraToggle = (e: React.MouseEvent) => {
		e.preventDefault();
		if (!localStream) return;

		for (const t of localStream.getVideoTracks()) {
			t.enabled = !t.enabled;
		}
	};

	useEffect(() => {
		// 1. Connect to the WebSocket server on mount.
		// Replace the URL's port/host with your actual local signaling server details
		setStatus("connecting");

		const wsUrl = `ws://${address}:${port}/ws`;

		signalingService.connect(wsUrl);
		setStatus("connected");

		// 2. Attach our listener to capture and log signaling envelopes
		const unsubscribe = signalingService.onMessage(async (env: Envelope) => {
			switch (env.type) {
				case MessageType.OFFER:
					await webrtcService.handleOffer(env.payload.sdp, "offer");
					break;
				case MessageType.ANSWER:
					await webrtcService.handleAnswer(env.payload.sdp, "answer");
					break;
				case MessageType.ICE:
					await webrtcService.handleIceCandidate(env.payload);
					break;
				case MessageType.LEAVE:
					setInRoom(false);
					webrtcService.hangUp();
					break;
				case MessageType.JOIN: {
					setInRoom(true);
					const payload = env.payload as Record<string, unknown>;
					if (payload?.token) setToken(payload.token as string);
				}
			}

			setMessages(prev => [...prev, env]);
		});

		// Clean up websocket listeners upon component unmount
		return () => {
			unsubscribe();
			signalingService.disconnect();
		};
	}, [setStatus, address, port]);

	useEffect(() => {
		webrtcService.onRemoteStream = stream => {
			if (remoteVideoRef.current) remoteVideoRef.current.srcObject = stream;
		};

		webrtcService.onConnectionStateChange = state => {
			setConnectionState(state); // Local state for UI display
			if (state === "failed") handleHangUp();
		};
	}, [handleHangUp]);

	// Auto-scroll messaging widget downwards
	useEffect(() => {
		endOfMessagesRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages]);

	useEffect(() => {
		if (!inRoom) return;

		if (!localStream) {
			getLocalStream().then(localStream => {
				setLocalStream(localStream);
			});
		}

		if (
			localStream &&
			localVideoRef.current &&
			localVideoRef.current.srcObject !== localStream
		) {
			localVideoRef.current.srcObject = localStream;
		}
	}, [localStream, inRoom]);

	return (
		<div
			className='container'
			style={{ padding: "20px", fontFamily: "sans-serif" }}
		>
			<h1>PrivChat Lobby</h1>

			<div style={{ marginBottom: "20px" }}>
				Status:{" "}
				<strong style={{ color: status === "connected" ? "green" : "red" }}>
					{status}
				</strong>
			</div>

			{!inRoom ? (
				<form
					onSubmit={handleJoin}
					style={{
						display: "flex",
						flexDirection: "column",
						gap: "10px",
						maxWidth: "300px"
					}}
				>
					<label>
						Room ID:
						<input
							type='text'
							value={roomId}
							onChange={e => setRoomId(e.target.value)}
							placeholder='e.g. test-room'
							style={{ width: "100%", padding: "5px" }}
							required
						/>
					</label>
					<label>
						Invite Token (Optional):
						<input
							type='text'
							value={token}
							onChange={e => setToken(e.target.value)}
							placeholder='Leave blank to create a new room'
							style={{ width: "100%", padding: "5px" }}
						/>
					</label>
					<button
						type='submit'
						style={{ padding: "10px 15px", cursor: "pointer" }}
					>
						Join / Create
					</button>
				</form>
			) : (
				<div
					style={{
						border: "1px solid #ccc",
						padding: "15px",
						borderRadius: "8px"
					}}
				>
					<div
						style={{
							display: "flex",
							justifyContent: "space-between",
							marginBottom: "10px"
						}}
					>
						<h2>Room: {roomId}</h2>
						<button
							type='button'
							onClick={handleDisconnectAction}
							style={{
								padding: "5px 10px",
								background: "red",
								color: "white",
								border: "none"
							}}
						>
							Leave
						</button>
					</div>

					<div
						style={{
							background: "#f5f5f5",
							padding: "10px",
							marginBottom: "15px"
						}}
					>
						<strong>Invite Token: </strong> {token}
						<button
							type='button'
							onClick={() => navigator.clipboard.writeText(token)}
							style={{ marginLeft: "10px", padding: "2px 8px" }}
						>
							Copy
						</button>
					</div>

					<div
						style={{
							height: "200px",
							overflowY: "auto",
							border: "1px solid #000",
							padding: "10px",
							marginBottom: "15px"
						}}
					>
						{messages.map((msg, i) => (
							<div
								key={i}
								style={{ padding: "5px", borderBottom: "1px solid #eee" }}
							>
								<span style={{ fontWeight: "bold", marginRight: "10px" }}>
									[{msg.type}]
								</span>
								<span>{JSON.stringify(msg.payload)}</span>
							</div>
						))}
						<div ref={endOfMessagesRef} />
					</div>

					<form
						onSubmit={handleSendMessage}
						style={{ display: "flex", gap: "10px" }}
					>
						<input
							type='text'
							value={outgoingMsg}
							onChange={e => setOutgoingMsg(e.target.value)}
							placeholder='Type a test message...'
							style={{ flex: 1, padding: "5px" }}
						/>
						<button type='submit' style={{ padding: "5px 15px" }}>
							Send
						</button>
					</form>
					<div>
						{/** biome-ignore lint/a11y/useMediaCaption: <dev> */}
						<video ref={remoteVideoRef} autoPlay playsInline />
						<span>{connectionState}</span>
						<video
							ref={localVideoRef}
							autoPlay
							muted
							playsInline
							style={{ transform: "scaleX(-1)" }}
						/>
						<button
							type='button'
							style={{ padding: "1px 3px" }}
							onClick={handleMicToggle}
						>
							Mic toggle
						</button>
						<button
							type='button'
							style={{ padding: "1px 3px" }}
							onClick={handleCameraToggle}
						>
							Cam toggle
						</button>

						<button
							type='button'
							style={{ padding: "1px 3px" }}
							onClick={handleHangUp}
						>
							hang up
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

export default App;
