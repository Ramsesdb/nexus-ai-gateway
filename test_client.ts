/**
 * Nexus AI Gateway - Stress Test Client
 * Tests all providers with detailed logging
 */

const API_URL = "http://localhost:3000";
const API_KEY = process.env.NEXUS_MASTER_KEY || "";

// Build auth headers
const getHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (API_KEY) {
        headers["Authorization"] = `Bearer ${API_KEY}`;
    }
    return headers;
};

interface TestResult {
    testNum: number;
    message: string;
    success: boolean;
    responseTime: number;
    provider?: string;
    error?: string;
    responseLength: number;
}

interface HealthMetrics {
    successCount: number;
    failCount: number;
    avgLatency: number;
}

interface HealthProvider {
    name: string;
    circuitState: string;
    metrics: HealthMetrics;
}

interface HealthResponse {
    status: string;
    version: string;
    uptime: number;
    inFlightRequests: number;
    providers: HealthProvider[];
}

const results: TestResult[] = [];

async function testChat(message: string, testNum: number): Promise<TestResult> {
    const startTime = Date.now();
    console.log(`\n${"=".repeat(60)}`);
    console.log(`🧪 TEST #${testNum}: "${message}"`);
    console.log(`⏱️  Started at: ${new Date().toISOString()}`);
    console.log(`${"=".repeat(60)}`);

    const result: TestResult = {
        testNum,
        message,
        success: false,
        responseTime: 0,
        responseLength: 0,
    };

    try {
        const response = await fetch(`${API_URL}/v1/chat/completions`, {
            method: "POST",
            headers: getHeaders(),
            body: JSON.stringify({
                messages: [{ role: "user", content: message }],
                stream: true,
            }),
            // @ts-ignore - Bun specific
            verbose: true,
        });

        console.log(`📡 Response Status: ${response.status}`);
        console.log(`📡 Headers:`, Object.fromEntries(response.headers.entries()));

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`❌ HTTP Error ${response.status}: ${errorText}`);
            result.error = `HTTP ${response.status}: ${errorText}`;
            result.responseTime = Date.now() - startTime;
            return result;
        }

        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let fullText = "";
        let chunkCount = 0;

        if (!reader) {
            result.error = "No response body";
            result.responseTime = Date.now() - startTime;
            return result;
        }

        console.log(`\n📝 Response:\n${"-".repeat(40)}`);

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            chunkCount++;
            const chunk = decoder.decode(value);
            const lines = chunk.split("\n");

            for (const line of lines) {
                if (line.startsWith("data: ") && line !== "data: [DONE]") {
                    try {
                        const data = JSON.parse(line.substring(6));
                        if (data.choices?.[0]?.delta?.content) {
                            const content = data.choices[0].delta.content;
                            process.stdout.write(content);
                            fullText += content;
                        }
                    } catch (e) {
                        // Partial chunk, ignore
                    }
                }
            }
        }

        console.log(`\n${"-".repeat(40)}`);
        console.log(`📊 Chunks received: ${chunkCount}`);
        console.log(`📊 Total characters: ${fullText.length}`);

        result.success = true;
        result.responseLength = fullText.length;
        result.responseTime = Date.now() - startTime;

        console.log(`✅ Test #${testNum} PASSED in ${result.responseTime}ms`);
    } catch (error: any) {
        result.responseTime = Date.now() - startTime;
        result.error = error.message || String(error);
        console.error(`\n❌ Test #${testNum} FAILED: ${result.error}`);
        console.error(`   Code: ${error.code || "N/A"}`);
        console.error(`   Path: ${error.path || "N/A"}`);
    }

    return result;
}

async function checkHealth() {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`🏥 HEALTH CHECK`);
    console.log(`${"=".repeat(60)}`);

    try {
        const res = await fetch(`${API_URL}/health`);
        const data = await res.json() as HealthResponse;
        console.log(`Status: ${data.status}`);
        console.log(`Version: ${data.version}`);
        console.log(`Uptime: ${Math.round(data.uptime)}s`);
        console.log(`In-Flight: ${data.inFlightRequests}`);
        console.log(`\nProviders:`);
        for (const p of data.providers) {
            const metrics = p.metrics;
            console.log(
                `  - ${p.name}: ${p.circuitState} | ` +
                `Success: ${metrics.successCount}/${metrics.successCount + metrics.failCount} | ` +
                `Avg Latency: ${Math.round(metrics.avgLatency)}ms`
            );
        }
    } catch (e: any) {
        console.error(`Health check failed: ${e.message}`);
    }
}

async function runStressTest() {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║         NEXUS AI GATEWAY - STRESS TEST                       ║
╠══════════════════════════════════════════════════════════════╣
║  Testing all providers with detailed logging                 ║
╚══════════════════════════════════════════════════════════════╝
`);

    // Initial health check
    await checkHealth();

    const testMessages = [
        "Solve this logic puzzle: I have 3 apples. Yesterday I ate one. Today I bought two more. Tomorrow I verify that half of my remaining apples are rotten and I throw them away. How many good apples do I have left? Explain step by step.",
    ];

    for (let i = 0; i < testMessages.length; i++) {
        const msg = testMessages[i];
        if (!msg) continue;
        const result = await testChat(msg, i + 1);
        results.push(result);

        // Wait between requests to avoid rate limiting
        if (i < testMessages.length - 1) {
            console.log(`\n⏳ Waiting 3 seconds before next test...`);
            await new Promise((r) => setTimeout(r, 3000));
        }
    }

    // Final health check
    await checkHealth();

    // Summary
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                      TEST SUMMARY                            ║
╚══════════════════════════════════════════════════════════════╝
`);

    const passed = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    const avgTime =
        results.reduce((a, b) => a + b.responseTime, 0) / results.length;

    console.log(`✅ Passed: ${passed}/${results.length}`);
    console.log(`❌ Failed: ${failed}/${results.length}`);
    console.log(`⏱️  Avg Response Time: ${Math.round(avgTime)}ms`);

    if (failed > 0) {
        console.log(`\n⚠️  Failed Tests:`);
        for (const r of results.filter((r) => !r.success)) {
            console.log(`   - Test #${r.testNum}: ${r.error}`);
        }
    }
}

runStressTest();
