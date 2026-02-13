const http = require('http');
const net = require('net');
const url = require('url');

const proxy = http.createServer((req, res) => {
    console.log('HTTP Request:', req.method, req.url, req.headers);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('okay');
});

proxy.on('connect', (req, clientSocket, head) => {
    const { port, hostname } = new url.URL(`http://${req.url}`);
    console.log('CONNECT Request:', req.url, hostname, port);

    const serverSocket = net.connect(port || 443, hostname, () => {
        clientSocket.write(
            'HTTP/1.1 200 Connection Established\r\n' +
                'Proxy-agent: Node.js-Proxy\r\n' +
                '\r\n',
        );
        serverSocket.write(head);
        serverSocket.pipe(clientSocket);
        clientSocket.pipe(serverSocket);
    });

    serverSocket.on('error', (err) => {
        console.error('ServerSocket Error:', err);
        clientSocket.end();
    });

    clientSocket.on('error', (err) => {
        console.error('ClientSocket Error:', err);
        serverSocket.end();
    });
});

proxy.listen(8081, () => {
    console.log('Proxy listening on port 8081');
});
