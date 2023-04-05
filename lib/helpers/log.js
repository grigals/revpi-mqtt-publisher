require('dotenv').config();

/**
 * Convenience function which logs a message to the console along with the calling function
 * @param {Any} msg Message to print to console
 */
module.exports = function log(msg) {
    if (process.env.DEBUG == "true"){
        let caller = (new Error()).stack.split("\n")[2].split('/').pop().replace(')','');
        console.log(`DEBUG [${(new Date).toISOString()}] ${caller} --> ${msg}`);
    }
}