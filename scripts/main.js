const fs = require('fs');
const path = require('path');
const { dialog } = require('electron').remote
const papaparse = require('papaparse');

// Replace with your API Key
const API_KEY = "AIzaSyCel8LMzmBd9EmULUe1M8WTzMFIOQjROsM";

// Expected input columns - throws error if these do not exist in input file
const ADDRESS_COLUMNS = ["Address1", "Address2", "City", "State", "Post Code", "Country"];

const ADDRESS_QUERY_COLUMNS = ["Address1", "Address2", "City", "State", "Post Code", "Country"]; // Columns get concatenated with separator

// Separator for address columns (if multiple columns)
const ADDRESS_QUERY_COLUMNS_SEPARATOR = " ";

const ADDRESS_COMPONENTS = {
    // "Country": "country",
    // "City": "locality",
    // "State": "administrative_area"
};

const REGION_BIAS_SELECTION = [
    { value: '', text: 'Select Region Bias' },
    { value: 'AU', text: 'Australia' },
    { value: 'US', text: 'United States' },
    { value: 'NZ', text: 'New Zealand' }
];
var REGION_BIAS = "";

const MAX_QUERIES_PER_SECOND = 9; // As of Sep 2019, Google has a max QPS of 10 ??
const MAX_QUERY_RETRIES = 3; // Number of times a single request will retry after failing
const MAX_QUERY_TOTAL_RETRIES = 100; // Total number of retries for all combined requests (set to 0 for unlimited)

const addressColumnMapping = {
    "Sub Premise": { type: "subpremise", name_type: "short_name" },
    "Premise": { type: "premise", name_type: "short_name" },
    "Street Number": { type: "street_number", name_type: "short_name" },
    "Route": { type: "route", name_type: "short_name" },
    "City": { type: "locality", name_type: "short_name" },
    "State": { type: "administrative_area_level_1", name_type: "short_name" },
    "Post Code": { type: "postal_code", name_type: "short_name" },
    "Country": { type: "country", name_type: "short_name" }
    // "Street Address": { type: "street_address", name_type: "short_name"},
    // "Sub Locality": { type: "sublocality", name_type: "short_name" },
    // "Area 2": { type: "administrative_area_level_2", name_type: "short_name" },
    // "Area 3": { type: "administrative_area_level_3", name_type: "short_name" },
    // "Area 4": { type: "administrative_area_level_4", name_type: "short_name" },
    // "Area 5": { type: "administrative_area_level_5", name_type: "short_name" },
    // "Post Box": { type: "post_box", name_type: "short_name" }
};

const placeTypeWhitelist = ['premise', 'street_address', 'subpremise']; // Only cleanse these place types

let baseApiUrl = "https://maps.googleapis.com/maps/api/geocode/json?key=" + API_KEY;

let requests = []; // Gets populated with AJAX requests
let running = false;
let queue = 0;
let totalRequests = 0; // Total number of requests to be sent
let requestCount = 0; // Keeps track of how many requests have been sent in total (for throttling)
let qps = 0; // Current queries per second
let startTime = null;

let input = null;
let output = [];

// Start here
$(document).ready(function() {
    // Set up button listeners etc.
    setUpListeners();
});

function setUpListeners() {

    for(let i = 0; i < REGION_BIAS_SELECTION.length; i++) {
        let r = REGION_BIAS_SELECTION[i];
        let opt = $('<option value="' + r.value + '">' + r.text + '</option>');
        $('#selRegionBias').append(opt);
    }

    $('#selRegionBias').on('change', function() {
        REGION_BIAS = $(this).val();
    });

    // Button - Browse
    $('#btnBrowse').on('click', function() {
        showFilePicker().then(loadFile).then(prepareRequests).catch(errorHandler);
    });

    // Button - Export
    $('#btnExport').on('click', exportFile);

    // Button - Start
    $('#btnStart').on('click', start);

    // Button - Remove
    $('#btnRemove').on('click', function() {
        reset();
        log(`-- REMOVED --`);
    });

    // Button - Pause
    $('#btnPause').on('click', function() {
        running = false;
        $('#file').removeClass('running');
        log(`-- PAUSED --`);
    });

    // Button - Stop
    $('#btnStop').on('click', function() {
        running = false;
        $('#file').removeClass('running');
        $('#file').find('.progress-bar').css('width', '0%').attr('aria-valuenow', 0);
        $('#file').find('.file-progress-info').html(`${totalRequests} / ${input.data.length} Records Ready.`);
        reset(true);
        log(`-- STOPPED --`);
    });
}

/**
 * Shows the Open File Dialog and returns a file path
 *
 * @returns {string} filePath - Path to the specified file
 */
function showFilePicker() {
    return new Promise(function(resolve, reject) {
        dialog.showOpenDialog(null, {
            title: "Select CSV File",
            promptToCreate: true,
            properties: [
                'openFile',
                'promptToCreate',
                'dontAddToRecent'
            ],
            filters: [
                { name: 'CSV Files', extensions: ['csv'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        }).then(function(result) {
            if(result.canceled)
                reject({ status: "OK", message: "showOpenDialog Cancelled." });
            else if(result.filePaths && result.filePaths[0])
                resolve(result.filePaths[0]);
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

            // Error handling
            if(csv.errors && csv.errors.length > 0)
                reject({ status: "ERROR", message: "CSV Parse Errors. Check console for details", details: csv.errors });

            // Return file data
            if(csv.data && csv.data.length > 0) {

                let fileName = path.basename(filePath, path.extname(filePath));

                let file = {
                    name: fileName,
                    path: path.dirname(filePath),
                    data: csv.data,
                    fields: csv.meta.fields
                };
                resolve(file); // Return file data
            }
            else {
                reject({ status: "ERROR", message: "Error: CSV Empty" });
            }
        });
    });
}

function prepareRequests(file) {

    reset();

    input = file;

    // Make sure all expected address columns exist
    for(let i = 0; i < ADDRESS_COLUMNS.length; i++) {
        if(file.fields.indexOf(ADDRESS_COLUMNS[i]) === -1)
            throw ({ status: "ERROR", message: `Column not found, Expected column: '${ADDRESS_COLUMNS[i]}'` });
    }

    // Make sure all expected address query columns exist
    for(let i = 0; i < ADDRESS_QUERY_COLUMNS.length; i++) {
        if(file.fields.indexOf(ADDRESS_QUERY_COLUMNS[i]) === -1)
            throw ({ status: "ERROR", message: `Column not found, Expected column: '${ADDRESS_QUERY_COLUMNS[i]}'` });
    }

    // Make sure all address component columns exist
    for(let key in ADDRESS_COMPONENTS) {
        if(!ADDRESS_COMPONENTS.hasOwnProperty(key))
            continue;

        if(file.fields.indexOf(key) === -1)
            throw ({ status: "ERROR", message: `Column not found, Expected column: '${key}'` });
    }

    // Populate requests to be sent
    let rows = file.data;
    let i = totalRequests = rows.length;
    while(i--) {

        let row = rows[i];

        let request = {};

        let address = [];

        // Add address columns
        for(let i = 0; i < ADDRESS_QUERY_COLUMNS.length; i++)
            address.push(row[ADDRESS_QUERY_COLUMNS[i]]);

        // Remove duplicate address values
        address.filter((item, index) => address.indexOf(item) === index);

        // Concatenate address values (and remove excess whitespace)
        address = address.join(ADDRESS_QUERY_COLUMNS_SEPARATOR).replace(/\s+/g, " ");

        // Skip if address is empty
        if(!address || address.trim() == "") {
            totalRequests--;
            request["skip"] = true;
            log.warn("WARNING: Skipping address (address empty) on line " + (i + 2));
        }
        else { // Has address, proceed

            // Construct initial URL with address
            let url = baseApiUrl + "&address=" + address;

            // Construct url address components
            let components = [];
            for(let key in ADDRESS_COMPONENTS) {
                if(!ADDRESS_COMPONENTS.hasOwnProperty(key))
                    continue;

                let col = ADDRESS_COMPONENTS[key]; // Column
                let val = row[key]; // Value

                if(val && val.trim() != "")
                    components.push(`${col}:${val}`);
            }

            // Add components to url
            if(components.length > 0) {
                url += "&components=";
                url += components.join("|");
            }

            // Request function
            request["request"] = function() {
                sendRequest(url, request);
            };

            request["numRequests"] = 0;
        }

        // Original row
        request["row"] = row;

        // Add request to array
        requests.push(request);
    }

    queue = totalRequests;

    let fileEl = $('#file');
    fileEl.find('.file-name').html(file.name);
    fileEl.find('.file-progress-info').html(`${totalRequests} / ${file.data.length} Records Ready.`);
    fileEl.addClass('shown');

    log(`${file.name} Loaded`);
}

function reset(keepInput) {

    keepInput = keepInput || false;

    requestCount = 0;
    qps = 0;
    requests = [];
    output = [];

    $('#file').find('.progress-bar').css('width', 0 + '%').attr('aria-valuenow', 0);
    $('#file').find('.file-progress-info').html(`${requestCount} of ${totalRequests} records complete.`);

    if(!keepInput) {
        input = null;
        $('#file').removeClass('shown');
    }
}

function start() {

    if(input === null || requests === null || requests.length <= 0) return;

    startTime = Date.now();

    $('#file').addClass('running');
    running = true;

    log(`-- STARTED --`);

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

                if(!request["skip"]) {
                    request["numRequests"]++; // Increment counter for this request
                    request["request"](); // Call the request

                    requestCount++;
                }
                else {
                    console.log("skipping");
                    console.log(request);
                    output.push(request["row"]);
                }
            }
            else {
                break;
            }
        }
    }, 200);
}

function exportFile() {
    if(output === null || output.length <= 0) {
        alert("Nothing to export");
        return;
    }

    let outputFile = path.normalize(input.path + "\\" + input.name + " (Cleansed)");

    showFileSaver(outputFile).then(saveFile).then(function() {
        log("-- EXPORTED --");
    }).catch(errorHandler);
}

function sendRequest(url, request) {

    // Append Region Bias to URL if populated
    if(REGION_BIAS != "")
        url += "&region=" + REGION_BIAS;

    $.ajax({
        url: url
    }).done(function(response) {
        parseResponse(response, request["row"]);
    }).fail(function() {
        log.error(`Error: Request Failed: ${url}`);
        console.error("REQUEST FAILED: ", url);
        // TODO: re-request - only request the same request a certain number of times (MAX_RETRIES) ?
    }).always(function() {
        if(--queue <= 0)
            finished();
    });
}

function parseResponse(response, row) {
    if(response && response.status) {
        switch(response.status) {
            case "ZERO_RESULTS":
            case "OK":
                parseResults(row, response.results);
                break;
            default:
                log.error(`Unhandled Response: ${response.status}. Check console for details.`)
                console.error(response);
                break;
        }
    }
    else {
        console.error("RESPONSE EMPTY");
    }
}

function parseResults(row, results) {

    if(results.length > 0) {

        // Get first result (best match)
        let result = results[0];

        let accuracy = result["geometry"]["location_type"];

        row["location_type"] = accuracy;
        row["types"] = result['types'].join("|");
        row["partial_match"] = result['partial_match'];

        let proceed = false;
        for(let i = 0; i < result['types'].length; i++) {
            if(placeTypeWhitelist.indexOf(result['types'][i]) > -1) {
                proceed = true;
            }
        }

        if(accuracy === "ROOFTOP" && !result['partial_match'] && proceed) {
            let addr = {};
            // Populate address columns
            for(let key in addressColumnMapping) {
                if(!addressColumnMapping.hasOwnProperty(key))
                    continue;
                let type = addressColumnMapping[key]["type"];
                let nameType = addressColumnMapping[key]["name_type"];
                let component = result["address_components"].filter(function(v) { return v["types"].indexOf(type) > -1 });
                addr[key] = component.length > 0 ? component[0][nameType].toString() : "";
            }

            // Concatenate fields for Address1, replace multiple spaces with one space, and trim leading/trailing spaces
            let addressConcat = "";

            if(addr['Sub Premise'] != "")
                addressConcat += `${addr['Sub Premise']}/`;

            addressConcat += `${addr['Street Number']} ${addr['Route']}`;
            addressConcat = addressConcat.replace(/\s+/g, " ").trim();

            row["Address1"] = (addr['Premise'] === "") ? addressConcat : addr['Premise'];
            row["Address2"] = (addr['Premise'] === "") ? "" : addressConcat;
            row["City"] = addr['City'];
            row["State"] = addr['State'];
            row["Post Code"] = addr['Post Code'];
            row["Country"] = addr['Country'];
        }
    }

    output.push(row);
}

function updateProgress() {

    let percent = (requestCount / totalRequests) * 100;

    $('#file').find('.progress-bar').css('width', percent + '%').attr('aria-valuenow', percent);
    $('#file').find('.file-progress-info').html(`${requestCount} of ${totalRequests} records complete.`);
}

// Called when all requests have been sent/received
function finished() {

    log("-- FINISHED --");

    updateProgress();

    $('#file').removeClass('running');
}

function showFileSaver(filePath) {
    return new Promise(function(resolve, reject) {
        dialog.showSaveDialog(null, {
            title: "Save File",
            defaultPath: filePath,
            filters: [
                { name: 'CSV Files', extensions: ['csv'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        }).then(function(result) {
            if(result.canceled)
                reject({ status: "OK", message: "showSaveDialog Cancelled." });
            else if(result.filePath)
                resolve(result.filePath);
        });
    });
}

function saveFile(filePath) {

    let csv = papaparse.unparse(output);

    return new Promise(function(resolve, reject) {
        fs.writeFile(filePath, csv, function(err) {
            if(err)
                reject({ status: "ERROR", message: "SaveFile Error. Check console for details", details: err });

            resolve();
        });
    });
}

function errorHandler(error) {
    if(error.status && error.status === "OK") {
        // handled error
    }
    else if(error.status && error.status !== "OK") {
        if(error.message && error.message.trim() !== "")
            log.error(error.message);
        else
            log.error("An unknown error has occured.");

        if(error.details && error.details.trim() !== "")
            console.error(error.details);
    }
    else if(error) {
        console.error(error);
    }
    else {
        console.error("Unhandled error.");
    }
}

function log(str) {
    let time = formatTime(Date.now());
    let logMessage = `${time}: ${str}`;
    let logLine = $('<p class="log-line log-info">' + logMessage + '</p>');
    $('#log-summary').append(logLine);
    log.update();
}
log.warn = function(str) {
    str = str.replace("&region", "&amp;region");
    let logLine = $('<p class="log-line log-warn">' + str + '</p>');
    $('#log-warnings').append(logLine);
    log.update();
};
log.error = function(str) {
    str = str.replace("&region", "&amp;region");
    let logLine = $('<p class="log-line log-err">' + str + '</p>');
    $('#log-errors').append(logLine);
    log.update();
};
log.update = function() {
    $('#log-summary-tab').html("Summary (" + $('#log-summary > p').length + ")");
    $('#log-warnings-tab').html("Warnings (" + $('#log-warnings > p').length + ")");
    $('#log-errors-tab').html("Errors (" + $('#log-errors > p').length + ")");
};

function formatTime(time) {
    var d = new Date(time);
    var hr = d.getHours();
    var min = d.getMinutes();
    var sec = d.getSeconds();
    if(min < 10) {
        min = "0" + min;
    }
    if(sec < 10)
        sec = "0" + sec;
    var ampm = " AM";
    if(hr > 12) {
        hr -= 12;
        ampm = " PM";
    }
    return hr + ":" + min + ":" + sec + ampm;
}