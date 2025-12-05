import admin from "firebase-admin";
import { readFileSync } from "fs";
import { join } from "path";

const serviceAccount = JSON.parse(
    readFileSync(join(__dirname, "../../serviceAccount.json"), "utf8")
);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

export default admin;
