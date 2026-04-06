export enum MessageType {
	JOIN = "join",
	OFFER = "offer",
	ANSWER = "answer",
	ICE = "ice",
	PUB_KEY = "pubkey",
	LEAVE = "leave",
	ERROR = "error"
}

export interface AnyEnvelope {
	v: number;
	type: MessageType;
	room: string;
	token?: string;
	payload?: unknown;
}

export interface RTCICEEnvelope extends AnyEnvelope {
	type: MessageType.ICE;
	payload: RTCIceCandidateInit;
}

export interface RTCSDPEnvelope extends AnyEnvelope {
	type: MessageType.OFFER | MessageType.ANSWER;
	payload: Required<RTCSessionDescriptionInit>;
}

export interface RTCLeaveEnvelope extends AnyEnvelope {
	type: MessageType.LEAVE;
}

export interface GenericEnvelope extends AnyEnvelope {
	type: MessageType.JOIN | MessageType.PUB_KEY | MessageType.ERROR;
}

export type Envelope =
	| RTCICEEnvelope
	| RTCSDPEnvelope
	| RTCLeaveEnvelope
	| GenericEnvelope;
