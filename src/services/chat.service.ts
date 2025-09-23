const messages = []; // placeholder for DB

export default {
    async saveMessage({ room, user, text }) {
        const msg = { id: Date.now(), room, user, text };
        messages.push(msg);
        return msg;
    },

    async getMessages(room) {
        return messages.filter((m) => m.room === room);
    },
};
