var random = require("random-js")();
var sync_request = require('sync-request');

// Change hostname to machine where you are running Elasticsearch.
var ESEARCH_URL = 'http://YourHostName:9200/test_results/TestResult';

var testCase = process.env.qm_RQM_TESTCASE_NAME;  // RQM built-in variable for test case name.
var exitCode = 0;
var verdict = 'passed';

// RQM passes execution variable to automated tests via environment variables which are prefixed with 'qm_'.
// This is the runId that was created in the test launcher app.
var runId = process.env.qm_runId;

// Insert test logic here...

if(random.bool()) { // Use random boolean to simulate a 50/50 chance that the test failed.
    exitCode = 1;
    verdict = 'failed';
}

// JSON document to post to Elasticsearch.
// Notice the document can have arbitrary attributes not defined in our .map file when setting up Elasticsearch (e.g. testCase).
var esearch_doc = {
    testCase: testCase,
    runId: runId,
    verdict: verdict
};

console.log('Posting Test Result to Elasticsearch: ', esearch_doc);

// sync_request is used to ensure the request completes before the process exits.
var response = sync_request('POST', ESEARCH_URL, {json: esearch_doc});

console.log('Response from Elasticsearch: ', response.getBody('utf-8'));

process.exit(exitCode);
