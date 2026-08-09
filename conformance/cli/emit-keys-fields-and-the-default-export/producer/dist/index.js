export default (n) => n + 1;
export class Service {
    handle = (n) => n * 2;
    static make = () => new Service();
}
