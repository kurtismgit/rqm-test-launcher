var express = require('express');
var child_process = require('child_process');
var os = require('os');
var superagent = require('superagent');

// Change hostname to machine where you are running Elasticsearch.
var ESEARCH_URL = 'http://YourHostName:9200/test_results/TestResult';

// Change slack incoming webhook url to the URL provided by your slack admin
var SLACK_WEBHOOK = 'https://hooks.slack.com/services/YourSlackWebhookURL';

// Change RQM information to match your environment.
var RQM_USERNAME = 'YourUserName';
var RQM_PASSWORD = 'YorPassword';
var RQM_PROJECT_NAME = "YourProjectName";  // Name of your RQM project area.
var RQM_SERVER_URI = 'https://YourServerName:9443/qm';  // Base URL for your RQM server.
var RQM_TSER_ID = 'YourExecutionRecordID';  // ID of Test Suite Execution Record you want to run.

var currentTask; // currently executing test
var taskQueue = [];  // queue of test task to be executed
var completedTasks = []; // recently completed executions

// Maps exit codes of RQM Execution Tool into meaningful strings (see: https://jazz.net/wiki/bin/view/Main/RQMExecutionTool )
var exitCodeMapping = {};
exitCodeMapping[20] = 'PASSED';
exitCodeMapping[21] = 'FAILED';
exitCodeMapping[22] = 'BLOCKED';
exitCodeMapping[23] = 'ERROR';
exitCodeMapping[24] = 'INCONCLUSIVE';
exitCodeMapping[25] = 'INCOMPLETE';
exitCodeMapping[30] = 'ERROR';

var app = express(); // creates a new server to listen for incoming HTTP request
app.get('/status', getStatus);  // server GET request for /status end-point to show state of this launcher app.
app.post('/run', queueTask); // server POST request to /run end-point.  Allows someone (or something) to initiate test execution.
app.get('/task', getTask); // server GET request for /task end-point.  Allows initiator to know when their task completes.

setInterval(processQueue, 3000); // start main interval that checks queue for task to run.

// information about activity and state of this test launcher.
function getStatus(req, res) {
    var status = '';

    if(currentTask) {
        status += 'Executing Current Task: ' + '\n';
        status += JSON.stringify(currentTask,null,2) + '\n';
    }

    status += 'Task Queue:' + '\n';
    status += JSON.stringify(taskQueue,null,2) + '\n';

    status += 'Completed Tasks:' + '\n';
    status += JSON.stringify(completedTasks,null,2) + '\n';

    res.send(status).end();
}

// return matching task based on runId in queryString.
function getTask(req, res) {
    var runId = req.query['runId'];
    var task;

    if (runId) {
        if (currentTask && currentTask.runId === runId) {
            task = currentTask;
        }

        for (var i = 0; i < taskQueue.length && !task; i++) {
            if(taskQueue[i].runId === runId) {
                task = taskQueue[i];
            }
        }

        for (var i = 0; i < completedTasks.length && !task; i++) {
            if(completedTasks[i].runId === runId) {
                task = completedTasks[i];
            }
        }
    }

    if(task) {
        res.json(task).end();
    } else {
        res.status(404).end();  // can't find a match.
    }
}

// queues a task to run a test.  return json object containing runId that can be used for initiator get task status.
function queueTask(req, res) {
    var runId = 'run_id_test_launcher_' + new Date().getTime(); // generate a random runId.
    var task = {
        runId: runId,
        exitStatus: 'pending' // Initiator can use /task to check exitStatus.  When no longer pending the run is complete.
    };

    taskQueue.push(task);
    res.json(task).end();
}

// pull task off queue and execute associated test suite via RQM Execution Tool.
function processQueue() {
    if(currentTask) { // only execute 1 thing at a time.
        return;
    }

    if(taskQueue.length === 0) {
        return;
    }

    // pull first task off the queue and run it.
    currentTask = taskQueue.shift();
    console.log('Running task.  runId: ' + currentTask.runId);

    // Execution tool will print the URL of the test suite result for this run.  This is the line containing that URL.
    var rqmResultUrlLine;
    var rqmProcess;

    try {
        // See https://jazz.net/wiki/bin/view/Main/RQMExecutionTool for meaning of each argument to execution tool.
        rqmProcess = child_process.spawn('java', [
            '-jar', 'RQMExecutionTool.jar',
            '-tserId=' + RQM_TSER_ID,
            '-user=' + RQM_USERNAME,
            '-password=' + RQM_PASSWORD,
            '-publicURI=' + RQM_SERVER_URI,
            '-projectName=' + RQM_PROJECT_NAME,
            '-exitOnComplete=true',
            '-printResultUrl=true',
            '-variables=runId:' + currentTask.runId  // Allows us to pass the runId to the actual test scripts executed on the RQM adapters.
        ], {
            cwd: 'rqm_execution_tool' // Execution tool is extract under this directory.
        });
    } catch(error) {
        console.error('Error spawning RQM Execution Tool: ', error);
        currentTask = null;
        return;
    }

    rqmProcess.stdout.on('data', function (data) {  // capture all data being sent to stdout by the RQM Execution Tool.
        console.log(data.toString());  // Echo anything RQM Execution Tool logging to stdout of launcher.

        if(!rqmResultUrlLine) {  // Search for the line where Execution Tool prints the result url.
            var lines = data.toString().split(os.EOL);

            for(var i = 0; i < lines.length; ++i) {
                var line = lines[i];
                if(line.indexOf('result url') === 0) {
                    rqmResultUrlLine = line;
                    break;
                }
            }
        }
    });

    rqmProcess.stderr.on('data', function (data) {
        console.error(data.toString());  // Echo anything RQM Execution Tool logging to stderr of launcher.
    });

    rqmProcess.on('close', function (exitCode) { // Execution Tool exited, so do post-processing (i.e. post result to slack).
        taskCompleted(currentTask, exitCode, rqmResultUrlLine);
        currentTask = null;
    });
}

// exitCode: exit status of the RQM Execution Tool process.  This maps to the test suites result status in RQM.
// rqmResultUrlLine: line printed by Execution Tool that contains link RQM result.
function taskCompleted(task, exitCode, rqmResultUrlLine) {
    var exitStatus = 'ERROR: Unknown Exit Status (' + exitCode + ')';
    var resultUrl = 'ERROR: Result URL Unavailable';

    if (exitCodeMapping[exitCode]) {
        exitStatus = exitCodeMapping[exitCode];
    }

    if (rqmResultUrlLine) {  // Additional processing needed, b/c RQM provides link to XML but we want link to RQM web interface.
        var resultID = rqmResultUrlLine.substring(rqmResultUrlLine.lastIndexOf(':') + 1);  // get RQM ID of result.
        resultUrl = encodeURI(RQM_SERVER_URI + '/web/console/' + RQM_PROJECT_NAME + '#action=com.ibm.rqm.planning.home.actionDispatcher&subAction=showSuiteResult&id=' + resultID);
    }

    console.log('Task completed.  runId: ' + task.runId + ' exitStatus: ' + exitStatus);

    var test_result_array = [];  // Results from Elasticsearch of all test ran as part of this suite.
    var query = {
        size: 100,
        query: {
            query_string: {
                query: 'runId:' + task.runId  // Elasticsearch query for all test results with matching runId
            }
        }
    };

    superagent.post(ESEARCH_URL + '/_search')  // Send the search query to Elasticsearch
        .type('application/json')
        .send(query)
        .end(function (err, res) {
            // Complete additional post-processing once the Elasticsearch query returns.
            if (err) {
                console.log('Error querying Elasticsearch.  err: ', err);
            } else if (res.ok) { // 200 response from Elasticsearch.
                var queryResult = res.body;

                if (queryResult.hits && queryResult.hits.hits) {
                    var docs = queryResult.hits.hits; // Actual docs are under hits.hits array of search result.

                    for (var i = 0; i < docs.length; ++i) {
                        test_result_array.push(docs[i]['_source']); // JSON doc we stored is in _source attribute of Elasticsearch document.
                    }
                } else {
                    console.log('ERROR: Elasticsearch query response does not contain expected hits attribute.  queryResult: ', queryResult);
                }
            } else {
                console.log('Unexpected response from Elasticsearch.  status: ' + res.status + ' body: ', res.body);
            }

            // Set meaningful data into completed task and send message to slack webhook.
            task.summary = computeResultSummary(test_result_array);
            task.exitStatus = exitStatus;
            task.resultUrl = resultUrl;  // Link to RQM result.
            sendSlackMessage(task);

            // Adds task to the completed task queue and prevent queue from growing unbound.
            completedTasks.unshift(task);
            if (completedTasks.length > 10) {
                completedTasks.pop();
            }
        });
}

// Extract the verdicts of the individual test results and constructs a summary object.
function computeResultSummary(test_result_array) {
    var resultSummary = {
        passed: 0,
        failed: 0,
        error: 0
    };

    test_result_array.forEach(function(test_result){
        if(test_result.verdict === 'passed') {
            resultSummary.passed++;
        } else if(test_result.verdict === 'failed') {
            resultSummary.failed++;
        } else {
            resultSummary.error++;
        }
    });

    return resultSummary;
}

// Post test result to slack.
function sendSlackMessage(task) {
    var message = 'Test Suite Completed. Passed[' + task.summary.passed + '] Failed[' + task.summary.failed + '] Error[' + task.summary.error + '] - ' + task.resultUrl;
    var body = {text: message}; // Slack requires message to be in a JSON object using text attribute.

    console.log('Posting message to slack: ', message);
    superagent.post(SLACK_WEBHOOK)
        .type('application/json')
        .send(body)
        .end(function (err, res) {
            if (err) {
                console.log('Error posting to slack.  err:', err);
            } else if (res.ok) {
                console.log('Successfully posted message to slack.  runId: ' + task.runId + ' exitStatus: ' + task.exitStatus);
            } else {
                console.log('Unexpected response from slack.  status: ' + res.status + ' body: ', res.body);
            }
        });
}

app.listen(5555);
console.log("server starting on port: " + 5555);
