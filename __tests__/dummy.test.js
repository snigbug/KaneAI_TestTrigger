require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

// CONFIGURATION
const USERNAME = process.env.LT_USERNAME;
const ACCESS_KEY = process.env.LT_ACCESS_KEY;
const PROJECT_ID = process.env.LT_PROJECT_ID;
const TARGET_TITLE = process.env.TARGET_TITLE;
const TARGET_ENV_NAMES = process.env.TARGET_ENV_NAMES.split(',');

// API Endpoints
const BASE_URL = 'https://test-manager-api.lambdatest.com/api/v1';
const KANE_AI_URL = 'https://test-manager-api.lambdatest.com/api/atm/v1/hyperexecute';

// Auth Header (Basic Auth)
const authHeader = `Basic ${Buffer.from(`${USERNAME}:${ACCESS_KEY}`).toString('base64')}`;

// Axios Instance
const api = axios.create({
    baseURL: BASE_URL,
    headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
    }
});

// Step 1: Get all test cases for the project
async function getTestCaseIdByTitle(title) {
    console.log(`[-] Fetching Test Cases for Project: ${PROJECT_ID}...`);
    try {
        const response = await api.get(`/projects/${PROJECT_ID}/test-cases?per_page=40`);
        const allTestCases = response.data.data;
        const foundCase = allTestCases.find(tc => tc.title === title);

        if (!foundCase) {
            throw new Error(`Test Case with title "${title}" not found in project.`);
        }

        // Create the custom JSON object
        const testCaseData = {
            test_case_id: foundCase.test_case_id,
            folder_id: foundCase.folder_id,
            title: foundCase.title,
            description: foundCase.description,
            created_by: foundCase.created_by 
        };

        console.log(`Found Case: ${testCaseData.title} (ID: ${testCaseData.test_case_id})`);
        return testCaseData;
    } catch (error) {
        console.error("Error fetching test cases:", error.message);
        throw error;
    }
}

// Step 2: Get formatted Environment objects based on specific Names
async function getEnvironmentsByName(targetNames, testCase) {
    console.log(`[-] Fetching Environments matching: ${targetNames.join(", ")}...`);
    
    try {
        const response = await api.get(`/environments?per_page=50`); 
        const allConfigs = response.data.data;

        const formattedEnvironments = [];

        for (const name of targetNames) {
            const config = allConfigs.find(c => c.name === name);

            if (config) {
                const innerEnv = config.environments[0];
                const envObject = {
                    id: config.id,
                    name: config.name,
                    os_name: innerEnv.os_name,
                    os: innerEnv.os,
                    browser_version: innerEnv.browser_version,
                    browser: innerEnv.browser,
                    os_version: innerEnv.os_version,
                    platform: innerEnv.platform || "desktop",
                    is_complete: true,
                    assignee: testCase.created_by,
                };

                formattedEnvironments.push(envObject);
                console.log(`Found & Formatted: ${name} (ID: ${config.id})`);
            } else {
                console.warn(`WARNING: Environment named "${name}" not found in API response.`);
            }
        }

        if (formattedEnvironments.length === 0) {
            throw new Error("No matching environments found.");
        }

        return formattedEnvironments;

    } catch (error) {
        console.error("Error fetching environments:", error.message);
        throw error;
    }
}

// Step 3: Create the Test Run with Nested Environments
async function createAndPopulateTestRun(testCase, environments) {
    console.log(`[-] Step 3a: Creating Test Run Shell...`);
    
    const createPayload = {
        title: `API GEN CI Run - ${new Date().toISOString().split('T')[0]}_${new Date().toTimeString().split(' ')[0].replace(/:/g, '-')}`,
        objective: "Triggered via Kane AI CI Orchestrator",
        test_run_instances: [],
        tags: ["CI", "KaneAI"],
        project_id: PROJECT_ID,
        is_auteur_generated: true
    };

    const createResponse = await api.post('/test-run', createPayload);
    const runData = createResponse.data.data || createResponse.data;
    const runId = runData.test_run_id || runData.id;

    if (!runId) throw new Error("Failed to generate Test Run ID");
    console.log(`> Created Shell Run ID: ${runId}`);

    console.log(`[-] Step 3b: Mapping ${environments.length} Environments to Instances...`);

    const instances = environments.map((env, index) => ({
        test_case_id: testCase.test_case_id,
        environment_id: env.id, 
        name: testCase.title,
        serial_no: index + 1,
        assignee: testCase.created_by, 
    }));

    const updatePayload = {
        id: runId,
        project_id: PROJECT_ID,
        title: createPayload.title,
        objective: createPayload.objective,
        tags: createPayload.tags,
        is_auteur_generated: true,
        test_run_instances: instances
    };

    try {
        await api.put(`/test-run/${runId}`, updatePayload);
        console.log(`> Successfully Populated Test Run ${runId} with ${instances.length} instances.`);
        return runId;
    } catch (error) {
        console.error("! Failed to populate test run:", error.response?.data);
        throw error;
    }
}

// Step 4: Trigger Kane AI Execution
async function triggerKaneAI(runId) {
    console.log(`[-] Triggering Kane AI Execution for Run ID: ${runId}...`);

    const payload = {
        test_run_id: runId,
        concurrency: 2,
        title: `KaneAI Build - ${runId}`,
        retry_on_failure: true,
        max_retries: 1
    };

    try {
        const response = await axios.post(KANE_AI_URL, payload, {
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/json'
            }
        });

        const data = response.data;
        const jobId = data.job_id || data.id || (data.data && data.data.job_id);

        if (!jobId) {
            throw new Error("Triggered successfully, but could not parse Job ID from response.");
        }

        console.log(`>>> Kane AI Execution Started! Job ID: ${jobId}`);
        const envContent = `KANE_JOB_ID=${jobId}`;
        fs.writeFileSync('kane_job.env', envContent);
        console.log("> Saved Job ID to kane_job.env");
    } catch (error) {
        console.error("! Failed to trigger Kane AI:", error.response ? error.response.data : error.message);
        throw error;
    }
}

// MAIN ORCHESTRATOR
test('Kane AI orchestration', async () => {
    // 1. Get Cases
    const testCaseInfo = await getTestCaseIdByTitle(TARGET_TITLE);

    // 2. Get Environment
    const environmentObjects = await getEnvironmentsByName(TARGET_ENV_NAMES, testCaseInfo);

    // 3. Create Run
    const runId = await createAndPopulateTestRun(testCaseInfo, environmentObjects);

    // 4. Trigger Execution
    await triggerKaneAI(runId);
}, 120000);
