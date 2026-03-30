package internal

import (
	"log"
	"time"

	"github.com/gorilla/websocket"
)

const ( // Time allowed to read the next pong message from the peer.
	pongWait = 40 * time.Second

	// Send pings to peer with this period. Must be less than pongWait.
	pingPeriod = 30 * time.Second
)

type Client struct {
	Conn *websocket.Conn
	Send chan []byte
}

func (c *Client) ReadPump(hub *Hub) {
	defer func() {
		hub.RemoveClient(c)
		c.Conn.Close()
	}()

	// Configure the heartbeat deadlines
	c.Conn.SetReadDeadline(time.Now().Add(pongWait))
	c.Conn.SetPongHandler(func(string) error {
		c.Conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, message, err := c.Conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure, websocket.CloseNormalClosure, websocket.CloseNoStatusReceived) {
				log.Printf("error: %v", err)
			}
			break // Triggered if the client disconnects OR if pongWait elapses
		}
		hub.RouteMessage(c, message)
	}
}

// WritePump pushes queued messages from the Send channel onto the WebSocket.
func (c *Client) WritePump() {
    ticker := time.NewTicker(pingPeriod)
    defer func() {
        ticker.Stop()
        c.Conn.Close()
    }()

    for {
        select {
        case message, ok := <-c.Send:
            if !ok {
                c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
                return
            }

            if err := c.Conn.WriteMessage(websocket.TextMessage, message); err != nil {
                return
            }
            
        case <-ticker.C:
            // Heartbeat: Send Ping
            if err := c.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
                return // If ping fails, connection is dead. Exit writePump.
            }
        }
    }
}