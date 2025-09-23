import { Server, Socket } from "socket.io";
import chatSocket from "./chat.socket";
// import notificationSocket from "./notification.socket";

export default (io: Server, socket: Socket) => {
    chatSocket(io, socket);
    // notificationSocket(io, socket);
};
