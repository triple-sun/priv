export enum MessageType {
	JOIN = "join",
	OFFER = "offer",
	ANSWER = "answer",
	ICE = "ice",
	PUB_KEY = "pubkey",
	LEAVE = "leave",
	ERROR = "error"
}

interface EnvelopeBase {
	v: number;
	type: MessageType;
	room: string;
	token?: string;
	payload?: unknown;
}

export interface RTCICEEnvelope extends EnvelopeBase {
	type: MessageType.ICE;
	payload: RTCIceCandidateInit;
}

export interface RTCSDPEnvelope extends EnvelopeBase {
	type: MessageType.OFFER | MessageType.ANSWER;
	payload: Required<RTCSessionDescriptionInit>;
}

export interface RTCLeaveEnvelope extends EnvelopeBase {
	type: MessageType.LEAVE;
}

export interface GenericEnvelope extends EnvelopeBase {
	type: MessageType.JOIN | MessageType.PUB_KEY | MessageType.ERROR;
}

export type Envelope =
	| RTCICEEnvelope
	| RTCSDPEnvelope
	| RTCLeaveEnvelope
	| GenericEnvelope;

export type AnyEnvelope = EnvelopeBase;
