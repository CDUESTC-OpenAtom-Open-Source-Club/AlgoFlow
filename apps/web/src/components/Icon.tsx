import { iconAssets } from '../icon-assets';

interface IconProps {
  name: string;
  className?: string;
}

export function Icon({ name, className = '' }: IconProps) {
  const asset = iconAssets[name];
  const classes = `icon ${className}`.trim();

  return asset ? (
    <img className={classes} src={asset} alt="" aria-hidden="true" />
  ) : (
    <span className={`${classes} icon-missing`} aria-hidden="true" data-icon={name} />
  );
}
