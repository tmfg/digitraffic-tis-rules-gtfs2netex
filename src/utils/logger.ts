import { createLogger, transports, format } from "winston";

const rootLogger = createLogger({
    transports: [new transports.Console()],
    format: format.combine(
        format.timestamp(),
        format.printf(({ timestamp, level, message }) => {
            return `[${timestamp}] ${level}: ${message}`;
        })
    ),
});

export {
    rootLogger
}
