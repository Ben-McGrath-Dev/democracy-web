from http.server import HTTPServer, SimpleHTTPRequestHandler
import ssl

HOST = "0.0.0.0"
PORT = 8443

CERT_FILE = "localhost+2.pem"
KEY_FILE = "localhost+2-key.pem"

server = HTTPServer((HOST, PORT), SimpleHTTPRequestHandler)

context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(certfile=CERT_FILE, keyfile=KEY_FILE)

server.socket = context.wrap_socket(
    server.socket,
    server_side=True
)

print()
print("Democracy Web HTTPS server")
print("============================")
print()
print(f"Port: {PORT}")
print()
print("Open on this PC:")
print(f"https://localhost:{PORT}")
print()
print("On another device use:")
print(f"https://YOUR-PC-IP:{PORT}")
print()

server.serve_forever()