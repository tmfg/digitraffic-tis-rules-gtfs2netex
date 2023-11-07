import { Element } from "libxmljs2";
import { Agency, Calendar, CalendarDateException, Gtfs, Route, FeedInfo } from "../utils/gtfs-types";
import { findCalendarDatesForTrips, findCalendarsForTrips, findTripsForRouteId, getCodeSpaceForAgency } from "./utils";
import _ from "lodash";
import {DateTime} from "ts-luxon";

function createDayTypesForRoute(
    gtfs: Gtfs,
    parent: Element,
    gtfsRoute: Route,
    agency: Agency
): { [service_id: string]: Element } {
    const trips = findTripsForRouteId(gtfs, gtfsRoute.route_id);
    const calendars = findCalendarsForTrips(gtfs, trips);
    const calendarDates = findCalendarDatesForTrips(gtfs, trips);

    const service_ids = Array.from(new Set([...calendars.map(c => c.service_id), ...calendarDates.map(cd => cd.service_id)]));

    const dayTypes = parent.node('dayTypes');
    const operatingDays = parent.node('operatingDays');
    const operatingPeriods = parent.node('operatingPeriods');
    const dayTypeAssignments = parent.node('dayTypeAssignments');
    const dayTypeElements: { [service_id: string]: Element } = {};
    const feedInfo = gtfs.feed_info && gtfs.feed_info[0];
    const cs = getCodeSpaceForAgency(agency, feedInfo as FeedInfo);

    const operatingDaysById: { [date: string]: Element } = {}; // Track created OperatingDay elements by date

    // Create OperatingDay elements for individual dates from calendarDates
    for (const calendarDate of calendarDates) {
        const isoDate = DateTime.fromFormat(calendarDate.date, 'yyyyMMdd').toISODate() as string;
        if (!operatingDaysById[isoDate]) {
            operatingDaysById[isoDate] = createOperatingDay(operatingDays, cs, isoDate);
        }
    }

    // Create OperatingDay elements for services with calendars but no calendarDates
    for (const calendar of calendars) {
        const startDate = DateTime.fromFormat(calendar.start_date, 'yyyyMMdd');
        const endDate = DateTime.fromFormat(calendar.end_date, 'yyyyMMdd');

        for (let date = startDate; date <= endDate; date = date.plus({ days: 1 })) {
            const isoDate = date.toISODate() as string;
            if (!operatingDaysById[isoDate]) {
                operatingDaysById[isoDate] = createOperatingDay(operatingDays, cs, isoDate);
            }
        }
    }
    let orderCounter = 1;
    for (const service_id of service_ids) {
        const dayTypeId = cs + 'DayType:' + service_id;
        const dayType = dayTypes.node('DayType').attr({ id: dayTypeId, version: '1' });

        const calendar = calendars.find(c => c.service_id === service_id);
        if (calendar) {
            dayType.node('properties').node('PropertyOfDay').node('DaysOfWeek', calendarDaysToString(calendar));

            const operPeriodId = cs + 'OperatingPeriod:' + service_id;
            const startDate = DateTime.fromFormat(calendar.start_date, 'yyyyMMdd');
            const endDate = DateTime.fromFormat(calendar.end_date, 'yyyyMMdd');

            const operPeriod = operatingPeriods.node('OperatingPeriod').attr({ id: operPeriodId, version: '1' });
            operPeriod.node('FromOperatingDayRef').attr({ ref: cs + 'OperatingDay:' + startDate.toISODate(), version: '1' });
            operPeriod.node('ToOperatingDayRef').attr({ ref: cs + 'OperatingDay:' + endDate.toISODate(), version: '1' });

            dayTypeAssignments.node('DayTypeAssignment')
                .attr({ id: cs + 'DayTypeAssignment:' + calendar.service_id, version: '1', order: (orderCounter++).toString() })
                .node('OperatingPeriodRef').attr({ ref: operPeriodId, version: '1' }).parent()
                .node('DayTypeRef').attr({ ref: dayTypeId, version: '1' });
        }

        const relatedCalendarDates = calendarDates.filter((calendarDate) => calendarDate.service_id === service_id);
        for (let i = 0; i < relatedCalendarDates.length; i++) {
            const calendarDate = relatedCalendarDates[i];
            const isoDate = DateTime.fromFormat(calendarDate.date, 'yyyyMMdd').toISODate() as string;

            if (!operatingDaysById[isoDate]) {
                // Check if OperatingDay element for this date already exists
                const operatingDay = createOperatingDay(operatingDays, cs, isoDate);
                operatingDaysById[isoDate] = operatingDay;
            }

            dayTypeAssignments.node('DayTypeAssignment')
                .attr({ id: cs + 'DayTypeAssignment:' + service_id + ':' + i, version: '1', order: (orderCounter++).toString() })
                .node('Date').text(isoDate).parent()
                .node('DayTypeRef').attr({ ref: dayTypeId, version: '1' }).parent()
                .node('isAvailable').text(calendarDate.exception_type == 1 ? 'true' : 'false');
        }
        dayTypeElements[service_id] = dayType;
    }
    return dayTypeElements;
}

function createOperatingDay(parent: Element, cs: string, isoDate: string): Element {
    const operatingDayId = cs + 'OperatingDay:' + isoDate;
    const operatingDay = parent.node('OperatingDay').attr({ id: operatingDayId, version: '1' });
    operatingDay.node('CalendarDate').text(isoDate);
    return operatingDay;
}

function calendarDaysToString(calendar: Calendar): string {
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const daysOfWeek = days.filter((day) => calendar[day as keyof Calendar] == 1);
    return daysOfWeek.map(_.capitalize).join(' ');
}

export { createDayTypesForRoute };
