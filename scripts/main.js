const fs = require("fs");
const path = require("path");
const { dialog } = require('electron').remote
const papaparse = require("papaparse");

const API_KEY = "AIzaSyCel8LMzmBd9EmULUe1M8WTzMFIOQjROsM";

// const IN_FILENAME = "Client Dump Test.csv";
// const OUT_FILENAME = "./output/output.csv";
const DEFAULT_OUTPUT_PATH = "output\\";

const DEFAULT_ADDRESS_COLUMN_NAME = "Full Address";
const DEFAULT_REGION_BIAS = "AU";

const MAX_QUERIES_PER_SECOND = 10; // As of Sep 2019, Google has a max QPS of 10 ??
const MAX_QUERY_RETRIES = 3; // Number of times a single request will retry after failing
const MAX_QUERY_TOTAL_RETRIES = 100; // Total number of retries for all combined requests (set to 0 for unlimited)

// const addressQueryComponents = {
//     "address": { column: "" }
// };

const addressColumns = {
    "Street Number": { type: "street_number", name_type: "short_name"},
    "Street Address": { type: "street_address", name_type: "short_name"},
    "Route": { type: "route", name_type: "short_name" },
    "Locality": { type: "locality", name_type: "short_name" },
    "Sub Locality": { type: "sublocality", name_type: "short_name" },
    "Post Code": { type: "postal_code", name_type: "short_name" },
    "Country": { type: "country", name_type: "short_name" },
    "Area 1": { type: "administrative_area_level_1", name_type: "short_name" },
    "Area 2": { type: "administrative_area_level_2", name_type: "short_name" },
    "Area 3": { type: "administrative_area_level_3", name_type: "short_name" },
    "Area 4": { type: "administrative_area_level_4", name_type: "short_name" },
    "Area 5": { type: "administrative_area_level_5", name_type: "short_name" },
    "Premise": { type: "premise", name_type: "short_name" },
    "Sub Premise": { type: "subpremise", name_type: "short_name" },
    "Post Box": { type: "post_box", name_type: "short_name" }
};

let baseUrlApi = "https://maps.googleapis.com/maps/api/geocode/json?key="+API_KEY+"&region="+DEFAULT_REGION_BIAS+"&address=";

let requests = []; // Gets populated with AJAX requests
let running = false;
let queue = 0;
let totalRequests = 0; // Total number of requests
let requestCount = 0; // Keeps track of how many requests have been sent in total (for throttling)
let qps = 0; // Current queries per second
let startTime = null;

let queryTotalRetries = 0;

let input = null;
let output = [];

// Start here
$(document).ready(function() {

    // Set up button listeners etc.
    setUpListeners();
});

function setUpListeners() {

    // Button - Browse
    $('#btnBrowse').on('click', function() {
        showFilePicker().then(loadFile).then(addFile).catch(errorHandler);
    });

    // Button - Start
    $('#btnStart').on('click', start);

    // Button - Remove
    $('#btnRemove').on('click', function() {
        
        running = false;


    });

    // Button - Pause
    $('#btnPause').on('click', function() {
        
        running = false;


    });

    // Button - Stop
    $('#btnStop').on('click', function() {
        
        running = false;


    });
}

/**
 * Shows the Open File Dialog and returns a file path
 *
 * @returns {string} filePath - Path to the specified file
 */
function showFilePicker() {
    return new Promise(function(resolve, reject) {
        dialog.showOpenDialog({
            title: "Select CSV File",
            promptToCreate: true,
            properties: ['openFile'],
            filters: [
                { name: 'CSV Files', extensions: ['csv'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        }, function(filePaths) {
            if(filePaths && filePaths.length === 1)
                resolve(filePaths[0]);
            else
                reject({ status: "OK", message: "showOpenDialog Cancelled." });
        });
    });
}

/**
 * Reads and returns data from the specified file
 *
 * @param {string} filePath - Path to the file
 * @returns {Object} file - The file
 * @returns {string} file.name - Name of the file (without extension)
 * @returns {Array} file.data - Contents of the file.
 */
function loadFile(filePath) {
    return new Promise(function(resolve, reject) {

        // Read file
        fs.readFile(filePath, function(err, fileData) {

            if(err)
                reject({ status: "ERROR", message: "ReadFile Error. Check console for details", details: err });

            fileData = fileData.toString();

            // Parse CSV into array
            let csv = papaparse.parse(fileData, {
                header: true,
                delimiter: ",",
                skipEmptyLines: true,
                error: function(error, file) {
                    reject({ status: "ERROR", message: "FileReader Error. Check console for details", details: { error: error, file: file } });
                }
            });

            if(csv.errors && csv.errors.length > 0)
                reject({ status: "ERROR", message: "CSV Parse Errors. Check console for details", details: csv.errors });

            if(csv.data && csv.data.length > 0) {
                let fileName = path.basename(filePath, path.extname(filePath));
                let file = { name: fileName, data: csv.data };
                resolve(file); // Return file data
            }
            else {
                reject({ status: "ERROR", message: "Error: CSV Empty" });
            }
        });
    });
}

function addFile(file) {

    input = file;

    let rows = file.data;

    requests = [];

    // Populate requests to be sent
    let i = rows.length;

    while(i--) {

        let row = rows[i];

        // Get address string
        let address = row[DEFAULT_ADDRESS_COLUMN_NAME];

        // Skip if address is empty
        if(address.trim() == "") continue;

        // Construct url
        let url = baseUrlApi + address;

        let componentList = [];

        // Add request to array
        requests.push({ "request": function() { sendRequest(url, row); }, "numRequests": 0 });
    }

    queue = totalRequests = requests.length;

    let fileEl = $('#file');
    fileEl.find('.file-name').html(file.name);
    fileEl.find('.file-progress-info').html(`${file.data.length} Records`);
    fileEl.find('.progress-bar').css('width', '0%').attr('aria-valuenow', 0);
    fileEl.addClass('shown');
}

function start() {

    if(input === null) return;

    $('#file').addClass('running');

    startTime = Date.now();

    running = true;

    let mainInterval = setInterval(function() {

        updateProgress();

        // If all requests are sent or manually paused/stopped
        if(requests.length <= 0 || running === false)
            clearInterval(mainInterval);

        // while there are requests left, fill the queue until limit is hit
        while(requests.length > 0) {

            // Calculate elapsed time in seconds
            var elapsedTime = (Date.now() - startTime) / 1000;

            // Calculate queries per second (number of total operations divided by total elapsed time)
            qps = requestCount / elapsedTime;

            // If max limit exceeded, wait and check again in the next interval
            if(qps >= MAX_QUERIES_PER_SECOND)
                break;

            if(running) {

                // Get next request and remove from array
                var request = requests.pop();

                // If this request has been sent before (is retrying)
                // if(request["numRequests"] > 0) {
                //     if(MAX_QUERY_TOTAL_RETRIES !== 0 && queryTotalRetries >= MAX_QUERY_TOTAL_RETRIES)
                //         break;
                //         if(request["numRequests"] >= MAX_QUERY_RETRIES) {
                        
                //         }
                //     }
                //     request["numRequests"]++;
                //     queryTotalRetries++;
                // }

                request["numRequests"]++; // Increment counter for this request
                request["request"](); // Call the request

                requestCount++;
            }
        }
    }, 100);
}

function sendRequest(url, row) {
    $.ajax({
        url: url
    }).done(function(response) {
        parseResponse(response, row);
    }).fail(function() {
        console.error("REQUEST FAILED: ", url);
        // TODO: re-request - only request the same request a certain number of times (MAX_RETRIES) ?
    }).always(function() {

        queue--;

        if(queue <= 0)
            finished();
    });
}

function parseResponse(response, row) {
    if(response && response.status) {
        switch(response.status) {
            case "OK":
                parseResults(row, response.results);
                break;
            default:
                console.error("failed: ", response);
                break;
        }
    }
    else {
        console.error("RESPONSE EMPTY");
    }
}

function parseResults(row, results) {

    console.log(results);

    // Get first result (best match)
    for(let i = 0; i < results.length; i++) {
    
        let result = results[i];

        let obj = {
            "Input": row["Full Address"],
            "Accuracy": result["geometry"]["location_type"],
            "Partial": (result["partial_match"] === true) || false,
            "Types": result["types"].join(",")
        };

        for(let key in addressColumns) {
            if(!addressColumns.hasOwnProperty(key))
                continue;

            var type = addressColumns[key]["type"];
            var nameType = addressColumns[key]["name_type"];

            obj[key] = getAddressComponent(result, type, nameType);
        }

        output.push(obj);
    }

    function getAddressComponent(result, type, nameType) {
        var component = result["address_components"].filter(function(v) { return v["types"].indexOf(type) > -1 });
        return component.length > 0 ? component[0][nameType] : "";
    }
}

function updateProgress() {

    let percent = (requestCount / totalRequests) * 100;

    $('#file').find('.progress-bar').css('width', percent + '%').attr('aria-valuenow', percent);
    $('#file').find('.file-progress-info').html(`${requestCount} of ${totalRequests} records complete. ? Remaining`);
}

// Called when all requests have been sent/received
function finished() {

    console.log("---- FINISHED ----");

    updateProgress();

    $('#file').removeClass('running');

    let fileName = input.name;

    console.log(input);
    console.log(fileName);

    // Save File
    showFileSaver(fileName).then(saveFile).catch(errorHandler);
}

function showFileSaver(fileName) {
    return new Promise(function(resolve, reject) {
        dialog.showSaveDialog({
            title: "Save File",
            defaultPath: DEFAULT_OUTPUT_PATH + fileName,
            filters: [
                { name: 'CSV Files', extensions: ['csv'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        }, function(filePath) {
            if(filePath && filePath != null)
                resolve(filePath);
            else
                reject({ status: "OK", message: "showSaveDialog Cancelled." });
        });
    });
}

function saveFile(filePath) {

    let csv = papaparse.unparse(output);

    return new Promise(function(resolve, reject) {
        fs.writeFile(filePath, csv, function(err) {
            if(err)
                reject({ status: "ERROR", message: "SaveFile Error. Check console for details", details: err });
        });
    });
}

function encodeQueryData(data) {
    const ret = [];
    for(let d in data)
        ret.push(encodeURIComponent(d) + '=' + encodeURIComponent(data[d]));
    return ret.join('&');
 }

/**
 * Alerts the user and prints out errors to the console
 *
 * @param {Object} error - Error object
 * @param {string} error.status - The status of the error ("OK", "ERROR")
 * @param {string} error.message - The message to be alerted to the user (in a popup box)
 * @param {*} [error.details] - Any additional details of the error
 *
 */
function errorHandler(error) {

    if(!error) return;

    if(error.status && error.status !== "OK") {
        if(error.message && error.message.trim() !== "")
            alert(error.message); // TODO - Make visual error banner
        else
            alert("An unknown error has occured.");

        if(error.details && error.details.trim() !== "")
            console.error(error.details);
    }
}