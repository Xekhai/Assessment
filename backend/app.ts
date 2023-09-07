import express from "express";
import { createClient } from "redis";
import { json } from "body-parser";

const DEFAULT_BALANCE = 100;

interface ChargeResult {
    isAuthorized: boolean;
    remainingBalance: number;
    charges: number;
}

async function connect(): Promise<ReturnType<typeof createClient>> {
    const url = `redis://${process.env.REDIS_HOST ?? "localhost"}:${process.env.REDIS_PORT ?? "6379"}`;
    console.log(`Using redis URL ${url}`);
    const client = createClient({ url });
    await client.connect();
    return client;
}

async function reset(account: string): Promise<void> {
    const client = await connect();
    try {
        await client.set(`${account}/balance`, DEFAULT_BALANCE);
    } finally {
        await client.disconnect();
    }
}

async function charge(account: string, charges: number): Promise<ChargeResult> {
    const client = await connect();
    try {
        let isAuthorized = false;
        let deductedAmount = 0;
        let remainingBalance = 0;

        client.watch(`${account}/balance`);

        const balanceStr = await client.get(`${account}/balance`);
        const balance = balanceStr ? parseInt(balanceStr) : DEFAULT_BALANCE;

        if (balance >= charges) {
            isAuthorized = true;
            deductedAmount = charges;
            remainingBalance = balance - charges;

            // Start the transaction
            const pipeline = client.multi();

            // Set the new balance
            pipeline.set(`${account}/balance`, remainingBalance.toString());

            const results = await pipeline.exec();

            // If exec returns null, it means the transaction failed due to watched value changing.
            if (!results[0]) {
                console.log("Detected concurrent modification. Transaction failed.");
                throw new Error("Concurrent modification detected. Transaction failed.");
            }

        } else {
            // If not enough balance, just retrieve the current balance.
            remainingBalance = parseInt(await client.get(`${account}/balance`) || "0", 10);
        }

        return {
            isAuthorized: isAuthorized,
            remainingBalance: remainingBalance,
            charges: deductedAmount
        };

    } finally {
        await client.disconnect();
    }
}

function isErrorWithMessage(error: any): error is { message: string } {
    return error && typeof error.message === 'string';
}


export function buildApp(): express.Application {
    const app = express();
    app.use(json());
    app.post("/reset", async (req, res) => {
        try {
            const account = req.body.account ?? "account";
            await reset(account);
            console.log(`Successfully reset account ${account}`);
            res.sendStatus(204);
        } catch (e) {
            console.error("Error while resetting account", e);
            res.status(500).json({ error: String(e) });
        }
    });
    app.post("/charge", async (req, res) => {
        try {
            const account = req.body.account ?? "account";
            const result = await charge(account, req.body.charges ?? 10);
            console.log(`Successfully charged account ${account}`);
            res.status(200).json(result);
        } catch (error) {
            if (isErrorWithMessage(error) && error.message.includes('watched keys has been changed')) {
                // console.error(`Error while charging account: ${error.message}`);
                res.status(500).send({ error: 'WatchError', message: 'One or more of the watched keys has been changed.' });
            } else {
                // Generic error handler
                console.error('An error occurred:', error);
                res.status(500).send({ error: 'InternalServerError', message: 'An unexpected error occurred.' });
            }
        }        
    });
    
    return app;
}
