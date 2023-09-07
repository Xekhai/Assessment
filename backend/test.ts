import { performance } from "perf_hooks";
import supertest from "supertest";
import { buildApp } from "./app";
import { createClient } from "redis";

const app = supertest(buildApp());
const defaultBalance = 100;
    const accountName = "test"; // default account name

async function basicLatencyTest() {
    await app.post("/reset").expect(204);
    const start = performance.now();
    await app.post("/charge").expect(200);
    await app.post("/charge").expect(200);
    await app.post("/charge").expect(200);
    await app.post("/charge").expect(200);
    await app.post("/charge").expect(200);
    console.log(`Basic Latency: ${performance.now() - start} ms`);
}
async function connect(): Promise<ReturnType<typeof createClient>> {
    const url = `redis://${process.env.REDIS_HOST ?? "localhost"}:${process.env.REDIS_PORT ?? "6379"}`;
    const client = createClient({ url });
    await client.connect();
    return client;
}

const chargeAmount = 20;

async function getBalance(): Promise<number> {
    const client = await connect();
    try {
        const balanceStr = await client.get(`${accountName}/balance`);
        return balanceStr ? parseInt(balanceStr) : 0;
    } finally {
        await client.disconnect();
    }
}

async function raceConditionTest() {
    await app.post("/reset").send({ account: accountName }).expect(204);

    // Fire off 5 simultaneous charge requests
    const chargeRequests = Array(20).fill(0).map(() => 
        app.post("/charge").send({ account: accountName, charges: chargeAmount })
    );

    const start = performance.now();
    const responses = await Promise.all(chargeRequests);
    const duration = performance.now() - start;
    console.log(`Race Condition Test Duration: ${duration} ms`);

    let successfulCharges = 0;

    // Log each response and count successful charges
    responses.forEach((response, index) => {
        console.log(`Request ${index + 1}:`, response.body);
        if (response.status === 200) {
            successfulCharges++;
        } else if (response.status === 500 && response.body.error === 'WatchError') {
            // Log and continue if this is an expected WatchError
            console.log('WatchError encountered, skipping this charge.');
        } else {
            throw new Error(`Unexpected error: ${response.body.error}`);
        }
    });

    // Calculate the expected balance based on the successful charges
    const expectedBalance = defaultBalance - (chargeAmount * successfulCharges);
    const actualBalance = await getBalance();
    if (actualBalance !== expectedBalance) {
        console.error(`Race Condition Detected! Expected Balance: ${expectedBalance}, Actual Balance: ${actualBalance}`);
    } else {
        console.log(`Race Condition Test Passed. Final Balance: ${actualBalance}`);
    }
}


async function runTests() {
    await basicLatencyTest();
    await raceConditionTest();
}

runTests().catch(console.error);
