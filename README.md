RQM Test Launcher App
======================

This is an application that is used to wrapper the RQM Execution Tool used to invoke RQM tests via the command-line.  This app provides a REST like API that can be used to launch RQM test and report the results back to slack.  Intended as a means of integrate RQM test suite execution with other frameworks used for software development/deploy.

## Before running this launcher.js application:

1. Install Elasticsearch.
2. Create a test_result index and POST the TestResult.map mapping.
3. Modify the constants in all CAPS at the top of launcher.js according to your environment.

## Related Links:

[General Info on RQM Execution Tool](https://jazz.net/wiki/bin/view/Main/RQMExecutionTool)  
[RQM Command-Line Adapter](https://jazz.net/library/article/809)  
[Look in all downloads section for your version of RQM](https://jazz.net/downloads/rational-quality-manager)

