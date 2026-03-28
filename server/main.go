package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

func handleConnections(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)

	if err != nil {
		log.Println("Upgrade failed:", err)
		return
	}

	defer conn.Close()

	for {
		messageType, message, err := conn.ReadMessage()

		if err != nil {
			log.Println("Error reading message:", err)
			break
		}

		err = conn.WriteMessage(messageType, message)
		if err != nil {
			log.Println("Error writing message:", err)
			break
		}
	}
}
func main() {
	port := flag.String("port", "8080", "Port for websocket connection")

	flag.Parse()

	http.HandleFunc("/ws", handleConnections)

	log.Printf("merhaba signaling server listening on %s", *port)

	if err := http.ListenAndServe(fmt.Sprintf(":%s", *port), nil); err != nil {
		log.Fatal("could not start server: ", err)
	}
}
