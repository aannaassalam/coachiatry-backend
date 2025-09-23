import { Response } from "express";

export const sendResponse = (
    res: Response,
    status: number,
    message: string,
    data?: any
) => {
    res.set("X-Message", message);
    res.set("Access-Control-Expose-Headers", "X-Message");
    res.status(status).json(data);
};
