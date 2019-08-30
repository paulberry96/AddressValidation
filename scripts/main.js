    const fs = require("fs");
const papaparse = require("papaparse");

const API_KEY = "AIzaSyCel8LMzmBd9EmULUe1M8WTzMFIOQjROsM";
const OUT_FILENAME = "./output/output.csv"
const IN_FILENAME = "Client Dump Test.csv"
const ADDRESS_COLUMN_NAME = "Full Address";
const RETURN_FULL_RESULTS = true;
const REGION_BIAS = "AU";

let base_url = "https://maps.googleapis.com/maps/api/geocode/json?key="+API_KEY+"&region="+REGION_BIAS+"&address=";

$(document).ready(function() {

    // Get CSV Data
    let csvData = getCSV(IN_FILENAME);

    if(csvData.errors.length > 0)
        console.error(csvData.errors);

    let rows = csvData.data;

    // Loop rows
    for(let i = 0; i < rows.length; i++) {

        let row = rows[i];

        let inputString = row[ADDRESS_COLUMN_NAME];

        // Next if string is empty
        if(inputString.trim() == "") continue;

        console.log("getting: ", inputString);

        let url = base_url + inputString;

        $.ajax({
            url: url
        }).done(function(result) {
            console.log(result);
        });
    }
});

function getCSV(filepath) {

    const file = fs.readFileSync(filepath).toString();

    var csv = papaparse.parse(file, {
        header: true,
        delimiter: ","
    });

    return csv;
}