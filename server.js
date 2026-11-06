const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const PORT = process.env.PORT || 3000;

// Указываем серверу, где искать файлы игры
app.use(express.static(__dirname + '/'));

// Принудительно открываем вашу игру при заходе на сайт
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/gorod-legend-v27.html');
});

// Логика мультиплеера
let players = {};
io.on('connection', (socket) => {
    console.log(`Игрок подключился: ${socket.id}`);
    
    players[socket.id] = { id: socket.id, x: 100, y: 100 };
    socket.emit('currentPlayers', players);
    socket.broadcast.emit('newPlayer', players[socket.id]);

    socket.on('playerMovement', (movementData) => {
        if (players[socket.id]) {
            players[socket.id].x = movementData.x;
            players[socket.id].y = movementData.y;
            socket.broadcast.emit('playerMoved', players[socket.id]);
        }
    });

    socket.on('disconnect', () => {
        console.log(`Игрок отключился: ${socket.id}`);
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
    });
});

// Запуск сервера на правильном порту для Render
http.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер работает. Комнат: 0, игроков: 0`);
});
