# AddressValidation
NodeJS Address Validation using Google Maps Geocode API
___
### Installation
1. Download and install [Node.js](https://nodejs.org/en/download/)
2. From the command line run
   ```
   git clone https://github.com/paulberry96/AddressValidation.git
   cd AddressValidation
   npm install
   ```
3. Get a [Google Api Key](https://developers.google.com/maps/documentation/javascript/get-api-key)
4. Navigate to scripts/main.js and replace the existing API Key with your key.
5. Run `npm start` to start the application. Or use `npm run package-win` to package the app into an executable.
___
### Usage
Browse for and select a CSV file with the following columns:
* Address1
* Address2
* City
* State
* Post Code
* Country

Press start and export when complete.
___
### Note
The validation is strict and will only fix addresses that are not partial.
