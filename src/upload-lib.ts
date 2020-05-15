import * as core from '@actions/core';
import * as http from '@actions/http-client';
import * as auth from '@actions/http-client/auth';
import * as io from '@actions/io';
import fileUrl from 'file-url';
import * as fs from 'fs';
import * as jsonschema from 'jsonschema';
import * as path from 'path';
import zlib from 'zlib';

import * as fingerprints from './fingerprints';
import * as sharedEnv from './shared-environment';
import * as util from './util';

// Construct the location of the sentinel file for detecting multiple uploads.
// The returned location should be writable.
async function getSentinelFilePath(): Promise<string> {
    // Use the temp dir instead of placing next to the sarif file because of
    // issues with docker actions. The directory containing the sarif file
    // may not be writable by us.
    const uploadsTmpDir = path.join(process.env['RUNNER_TEMP'] || '/tmp/codeql-action', 'uploads');
    await io.mkdirP(uploadsTmpDir);
    // Hash the absolute path so we'll behave correctly in the unlikely
    // scenario a file is referenced twice with different paths.
    return path.join(uploadsTmpDir, 'codeql-action-upload-sentinel');
}

// Takes a list of paths to sarif files and combines them together,
// returning the contents of the combined sarif file.
export function combineSarifFiles(sarifFiles: string[]): string {
    let combinedSarif = {
        version: null,
        runs: [] as any[]
    };

    for (let sarifFile of sarifFiles) {
        let sarifObject = JSON.parse(fs.readFileSync(sarifFile, 'utf8'));
        // Check SARIF version
        if (combinedSarif.version === null) {
            combinedSarif.version = sarifObject.version;
        } else if (combinedSarif.version !== sarifObject.version) {
            throw "Different SARIF versions encountered: " + combinedSarif.version + " and " + sarifObject.version;
        }

        combinedSarif.runs.push(...sarifObject.runs);
    }

    return JSON.stringify(combinedSarif);
}

// Upload the given payload.
// If the request fails then this will retry a small number of times.
async function uploadPayload(payload): Promise<boolean> {
    core.info('Uploading results');

    // If in test mode we don't want to upload the results
    const testMode = process.env['TEST_MODE'] === 'true' || false;
    if (testMode) {
        return true;
    }

    const githubToken = core.getInput('token');
    const ph: auth.BearerCredentialHandler = new auth.BearerCredentialHandler(githubToken);
    const client = new http.HttpClient('Code Scanning : Upload SARIF', [ph]);
    const url = 'https://api.github.com/repos/' + process.env['GITHUB_REPOSITORY'] + '/code-scanning/analysis';

    // Make up to 4 attempts to upload, and sleep for these
    // number of seconds between each attempt.
    // We don't want to backoff too much to avoid wasting action
    // minutes, but just waiting a little bit could maybe help.
    const backoffPeriods = [1, 5, 15];

    for (let attempt = 0; attempt <= backoffPeriods.length; attempt++) {

        const res: http.HttpClientResponse = await client.put(url, payload);
        core.debug('response status: ' + res.message.statusCode);

        const statusCode = res.message.statusCode;
        if (statusCode === 202) {
            core.info("Successfully uploaded results");
            return true;
        }

        const requestID = res.message.headers["x-github-request-id"];

        // On any other status code that's not 5xx mark the upload as failed
        if (!statusCode || statusCode < 500 || statusCode >= 600) {
            core.setFailed('Upload failed (' + requestID + '): (' + statusCode + ') ' + await res.readBody());
            return false;
        }

        // On a 5xx status code we may retry the request
        if (attempt < backoffPeriods.length) {
            // Log the failure as a warning but don't mark the action as failed yet
            core.warning('Upload attempt (' + (attempt + 1) + ' of ' + (backoffPeriods.length + 1) +
              ') failed (' + requestID + '). Retrying in ' + backoffPeriods[attempt] +
              ' seconds: (' + statusCode + ') ' + await res.readBody());
            // Sleep for the backoff period
            await new Promise(r => setTimeout(r, backoffPeriods[attempt] * 1000));
            continue;

        } else {
            // If the upload fails with 5xx then we assume it is a temporary problem
            // and not an error that the user has caused or can fix.
            // We avoid marking the job as failed to avoid breaking CI workflows.
            core.error('Upload failed (' + requestID + '): (' + statusCode + ') ' + await res.readBody());
            return false;
        }
    }

    return false;
}

// Uploads a single sarif file or a directory of sarif files
// depending on what the path happens to refer to.
// Returns true iff the upload occurred and succeeded
export async function upload(input: string): Promise<boolean> {
    if (fs.lstatSync(input).isDirectory()) {
        const sarifFiles = fs.readdirSync(input)
            .filter(f => f.endsWith(".sarif"))
            .map(f => path.resolve(input, f));
        if (sarifFiles.length === 0) {
            core.setFailed("No SARIF files found to upload in \"" + input + "\".");
            return false;
        }
        return await uploadFiles(sarifFiles);
    } else {
        return await uploadFiles([input]);
    }
}

// Validates that the given file path refers to a valid SARIF file.
// Returns a non-empty list of error message if the file is invalid,
// otherwise returns the empty list if the file is valid.
export function validateSarifFileSchema(sarifFilePath: string): string[] {
    const sarif = JSON.parse(fs.readFileSync(sarifFilePath, 'utf8'));
    const schema = JSON.parse(fs.readFileSync(__dirname + '/../src/sarif_v2.1.0_schema.json', 'utf8'));

    const result = new jsonschema.Validator().validate(sarif, schema);
    if (result.valid) {
        return [];
    } else {
        return result.errors.map(e => e.message);
    }
}

// Uploads the given set of sarif files.
// Returns true iff the upload occurred and succeeded
async function uploadFiles(sarifFiles: string[]): Promise<boolean> {
    core.startGroup("Uploading results");
    let succeeded = false;
    try {
        core.info("Uploading sarif files: " + JSON.stringify(sarifFiles));

        // Check if an upload has happened before. If so then abort.
        // This is intended to catch when the finish and upload-sarif actions
        // are used together, and then the upload-sarif action is invoked twice.
        const sentinelFile = await getSentinelFilePath();
        if (fs.existsSync(sentinelFile)) {
            core.info("Aborting as an upload has already happened from this job");
            return false;
        }

        // Validate that the files we were asked to upload are all valid SARIF files
        for (const file of sarifFiles) {
            const errors = validateSarifFileSchema(file);
            if (errors.length > 0) {
                core.setFailed("Unable to upload \"" + file + "\" as it is not valid SARIF:\n" + errors.join("\n"));
                return false;
            }
        }

        const commitOid = util.getRequiredEnvParam('GITHUB_SHA');
        const workflowRunIDStr = util.getRequiredEnvParam('GITHUB_RUN_ID');
        const ref = util.getRef();
        const analysisKey = await util.getAnalysisKey();
        const analysisName = util.getRequiredEnvParam('GITHUB_WORKFLOW');
        const startedAt = process.env[sharedEnv.CODEQL_ACTION_STARTED_AT];

        let sarifPayload = combineSarifFiles(sarifFiles);
        sarifPayload = fingerprints.addFingerprints(sarifPayload);

        const zipped_sarif = zlib.gzipSync(sarifPayload).toString('base64');
        let checkoutPath = core.getInput('checkout_path');
        let checkoutURI = fileUrl(checkoutPath);
        const workflowRunID = parseInt(workflowRunIDStr, 10);

        if (Number.isNaN(workflowRunID)) {
            core.setFailed('GITHUB_RUN_ID must define a non NaN workflow run ID');
            return false;
        }

        let matrix: string | undefined = core.getInput('matrix');
        if (matrix === "null" || matrix === "") {
            matrix = undefined;
        }

        const toolNames = util.getToolNames(sarifPayload);

        const payload = JSON.stringify({
            "commit_oid": commitOid,
            "ref": ref,
            "analysis_key": analysisKey,
            "analysis_name": analysisName,
            "sarif": zipped_sarif,
            "workflow_run_id": workflowRunID,
            "checkout_uri": checkoutURI,
            "environment": matrix,
            "started_at": startedAt,
            "tool_names": toolNames,
        });

        // Make the upload
        succeeded = await uploadPayload(payload);

        // Mark that we have made an upload
        fs.writeFileSync(sentinelFile, '');

    } catch (error) {
        core.setFailed(error.message);
    }
    core.endGroup();

    return succeeded;
}
