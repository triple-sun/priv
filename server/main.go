package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"priv-signal/internal"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins for now
	},
}

func handleConnection(w http.ResponseWriter, r *http.Request, hub *internal.Hub) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Upgrade failed:", err)
		return
	}

	client := &internal.Client{
		Conn: conn,
		Send: make(chan []byte, 256), // Add a reasonable buffer size for Send channel
	}

	// Start go-routines for reading and writing to this client
	go client.WritePump()
	go client.ReadPump(hub)
}

func main() {
	port := flag.String("port", "8080", "Port for websocket connection")
	flag.Parse()

	hub := internal.NewHub()

	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		handleConnection(w, r, hub)
	})

	log.Printf("priv signaling server listening on %s", *port)

	if err := http.ListenAndServe(fmt.Sprintf(":%s", *port), nil); err != nil {
		log.Fatal("could not start server: ", err)
	}
}
