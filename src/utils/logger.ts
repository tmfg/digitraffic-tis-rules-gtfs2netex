import winston from "winston";
import DailyRotateFile from 'winston-daily-rotate-file';
import {DateTime} from "ts-luxon";

const timezoned = () => {
    return DateTime.local().setZone('Europe/Helsinki').toFormat(`yyyy-MM-dd'T'HH:mm:ssZZ`);
};

const format = winston.format.combine(
    winston.format.timestamp({format: timezoned}),
    winston.format.json()
);

const rootLogger = winston.createLogger({
    level: 'debug',
    format: format,
    transports: [
        new DailyRotateFile({
            filename: 'gtfs2netex-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            dirname: '/tmp',
            level: 'debug',
            maxFiles: '14d'
        }),
    ],
});

function getTimestamp(): string {
    return DateTime.local().setZone('Europe/Helsinki').toFormat(`yyyy-MM-dd'T'HH:mm:ssZZ`);
}

export {
    rootLogger
}
