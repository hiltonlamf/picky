import { AlertIcon } from './icons';

export default function Disclaimer() {
  return (
    <div className="rounded-2xl bg-mint-100 p-4 text-sm text-forest/85">
      <p className="font-semibold text-forest mb-1 flex items-center gap-2">
        <AlertIcon className="w-4 h-4" />
        Always check with the restaurant
      </p>
      <p>
        AI can miss hidden ingredients like fish sauce, beef stock or anchovies, and menus change.
        If you have a serious dietary need or allergy, please confirm directly with the restaurant
        before ordering.
      </p>
    </div>
  );
}
